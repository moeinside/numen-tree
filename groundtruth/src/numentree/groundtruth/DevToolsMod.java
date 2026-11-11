package numentree.groundtruth;

import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.level.Level;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.entity.EntityJoinLevelEvent;
import net.neoforged.neoforge.event.entity.EntityLeaveLevelEvent;
import net.neoforged.neoforge.event.entity.living.LivingDamageEvent;
import net.neoforged.neoforge.event.entity.living.LivingDeathEvent;
import net.neoforged.neoforge.event.entity.player.ItemEntityPickupEvent;
import net.neoforged.neoforge.event.entity.player.PlayerContainerEvent;
import net.neoforged.neoforge.event.level.BlockEvent;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;

import numentree.groundtruth.audit.AuditLog;
import numentree.groundtruth.observe.ObserveStore;
import numentree.groundtruth.observe.SnapshotStore;
import numentree.groundtruth.portal.PortalCore;
import numentree.groundtruth.security.TokenStore;

/**
 * Numen Tree DevTools: dev-only GM command portal.
 *
 * <p>Disabled by default. When {@code config/numen-groundtruth.json} has
 * {@code enabled=true}, the mod reads a bearer token from
 * {@code config/numen-groundtruth.token} and listens on 127.0.0.1:8771. Commands
 * must pass the root allowlist and test-world allowlist, and are dispatched on
 * the server thread with permission level 4.</p>
 *
 * <p>The portal implementation is loaded reflectively so a production build can
 * omit {@code numentree.groundtruth.portal} entirely.</p>
 */
@Mod("numen_groundtruth")
public final class DevToolsMod {
    private static final String VERSION = PortalCore.VERSION;
    private static final String PORTAL_CLASS = "numentree.groundtruth.portal.PortalService";

    private static volatile Object portal;
    private static volatile AuditLog audit;
    private static volatile Path gameDir;
    private static volatile ObserveStore observe;
    private static volatile SnapshotStore snapshots;

    public DevToolsMod() {
        IEventBus bus = NeoForge.EVENT_BUS;
        bus.addListener(DevToolsMod::onServerStarted);
        bus.addListener(DevToolsMod::onServerStopping);
        bus.addListener(DevToolsMod::onServerTick);
        bus.addListener(DevToolsMod::onBlockBreak);
        bus.addListener(DevToolsMod::onBlockPlace);
        bus.addListener(DevToolsMod::onEntityJoin);
        bus.addListener(DevToolsMod::onEntityLeave);
        bus.addListener(DevToolsMod::onLivingDeath);
        bus.addListener(DevToolsMod::onLivingDamage);
        bus.addListener(DevToolsMod::onContainerOpen);
        bus.addListener(DevToolsMod::onContainerClose);
        bus.addListener(DevToolsMod::onItemPickup);
        log("v" + VERSION + " loaded (dev-only observability/debug; default disabled)");
    }

    private static void onServerTick(ServerTickEvent.Post event) {
        ObserveStore store = observe;
        if (store == null) return;
        MinecraftServer server = event.getServer();
        long dayTime = server.overworld().getDayTime();
        var clock = store.clock();
        if (!clock.frozen()) {
            store.tick(dayTime);
            return;
        }
        if (clock.pendingSteps() > 0) {
            // Let the server actually advance this tick; freeze again when the step budget is spent.
            store.tick(dayTime);
            if (store.clock().pendingSteps() == 0) {
                server.overworld().setDayTime(store.clock().dayTime());
            }
        } else {
            // Hard freeze: put dayTime back before the server advances it.
            server.overworld().setDayTime(clock.dayTime());
            store.tick(clock.dayTime());
        }
    }

    private static void onBlockBreak(BlockEvent.BreakEvent event) {
        ObserveStore store = observe;
        if (store == null || event.getLevel().isClientSide()) return;
        Map<String, Object> p = pos(event.getPos());
        p.put("block", BuiltInRegistries.BLOCK.getKey(event.getState().getBlock()).toString());
        if (event.getPlayer() != null) p.put("actor", event.getPlayer().getUUID().toString());
        p.put("dimension", dimension(event.getLevel()));
        store.append("block_break", p);
    }

    private static void onBlockPlace(BlockEvent.EntityPlaceEvent event) {
        ObserveStore store = observe;
        if (store == null || event.getLevel().isClientSide()) return;
        Map<String, Object> p = pos(event.getBlockSnapshot().getPos());
        p.put("block", BuiltInRegistries.BLOCK.getKey(event.getPlacedBlock().getBlock()).toString());
        if (event.getEntity() != null) p.put("actor", event.getEntity().getUUID().toString());
        p.put("dimension", dimension(event.getLevel()));
        store.append("block_place", p);
    }

    private static void onEntityJoin(EntityJoinLevelEvent event) {
        ObserveStore store = observe;
        if (store == null || event.getLevel().isClientSide()) return;
        store.append("entity_join", entityPayload(event.getEntity()));
    }

    private static void onEntityLeave(EntityLeaveLevelEvent event) {
        ObserveStore store = observe;
        if (store == null || event.getLevel().isClientSide()) return;
        store.append("entity_leave", entityPayload(event.getEntity()));
    }

    private static void onLivingDeath(LivingDeathEvent event) {
        ObserveStore store = observe;
        if (store == null || event.getEntity().level().isClientSide()) return;
        Map<String, Object> p = entityPayload(event.getEntity());
        p.put("damageType", event.getSource().getMsgId());
        store.append("entity_death", p);
    }

    private static void onLivingDamage(LivingDamageEvent.Post event) {
        ObserveStore store = observe;
        if (store == null || event.getEntity().level().isClientSide()) return;
        Map<String, Object> p = entityPayload(event.getEntity());
        p.put("damage", event.getNewDamage());
        p.put("damageType", event.getSource().getMsgId());
        if (event.getSource().getEntity() != null) {
            p.put("source", event.getSource().getEntity().getUUID().toString());
        }
        store.append("damage", p);
    }

    private static void onContainerOpen(PlayerContainerEvent.Open event) {
        ObserveStore store = observe;
        if (store == null || event.getEntity().level().isClientSide()) return;
        Map<String, Object> p = entityPayload(event.getEntity());
        p.put("container", event.getContainer().getClass().getSimpleName());
        store.append("container_open", p);
    }

    private static void onContainerClose(PlayerContainerEvent.Close event) {
        ObserveStore store = observe;
        if (store == null || event.getEntity().level().isClientSide()) return;
        Map<String, Object> p = entityPayload(event.getEntity());
        p.put("container", event.getContainer().getClass().getSimpleName());
        store.append("container_close", p);
    }

    private static void onItemPickup(ItemEntityPickupEvent.Post event) {
        ObserveStore store = observe;
        if (store == null || event.getPlayer().level().isClientSide()) return;
        Map<String, Object> p = entityPayload(event.getPlayer());
        p.put("item", BuiltInRegistries.ITEM.getKey(event.getCurrentStack().getItem()).toString());
        p.put("count", event.getCurrentStack().getCount());
        p.put("itemEntity", event.getItemEntity().getUUID().toString());
        store.append("item_pickup", p);
    }

    private static Map<String, Object> entityPayload(Entity entity) {
        Map<String, Object> p = pos(entity.blockPosition());
        p.put("entityType", BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString());
        p.put("entityId", entity.getUUID().toString());
        p.put("dimension", entity.level().dimension().location().toString());
        if (entity instanceof LivingEntity living) {
            p.put("hp", living.getHealth());
        }
        return p;
    }

    private static Map<String, Object> pos(BlockPos pos) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("x", pos.getX());
        p.put("y", pos.getY());
        p.put("z", pos.getZ());
        return p;
    }

    private static String dimension(net.minecraft.world.level.LevelAccessor level) {
        if (level instanceof Level l) return l.dimension().location().toString();
        return "unknown";
    }

    private static void onServerStarted(ServerStartedEvent event) {
        MinecraftServer server = event.getServer();
        gameDir = server.getServerDirectory();
        observe = new ObserveStore();
        snapshots = new SnapshotStore();
        DevToolsConfig config;
        try {
            config = DevToolsConfig.load(gameDir);
        } catch (Throwable t) {
            log("config load failed; portal stays disabled: " + t);
            return;
        }
        if (!config.enabled()) {
            log("disabled (config/numen-groundtruth.json enabled=false)");
            return;
        }
        List<String> problems = config.validateForServer();
        if (!problems.isEmpty()) {
            log("refusing to start: " + String.join("; ", problems));
            return;
        }

        AuditLog log = new AuditLog(gameDir.resolve("logs/numen-groundtruth-audit.jsonl"));
        audit = log;

        TokenStore tokens;
        Path tokenPath = config.resolveTokenPath(gameDir);
        try {
            tokens = TokenStore.load(tokenPath);
        } catch (Throwable t) {
            log("refusing to start: token unavailable at " + tokenPath + " (" + t.getMessage() + ")");
            startup(log, "denied", "token_unavailable", t.getMessage());
            return;
        }

        try {
            Class<?> cls = Class.forName(PORTAL_CLASS);
            Constructor<?> ctor = cls.getConstructor(
                    MinecraftServer.class, DevToolsConfig.class, AuditLog.class, TokenStore.class,
                    ObserveStore.class, SnapshotStore.class);
            Object service = ctor.newInstance(server, config, log, tokens, observe, snapshots);
            cls.getMethod("start").invoke(service);
            portal = service;
            Map<String, Object> fields = new LinkedHashMap<>();
            fields.put("event", "startup");
            fields.put("decision", "listening");
            fields.put("bind", config.bindAddress());
            fields.put("port", config.port());
            fields.put("allowedWorlds", config.allowedWorlds());
            fields.put("maxPerMinute", config.maxPerMinute());
            fields.put("maxCommandLength", config.maxCommandLength());
            safeAppend(log, fields);
            log("listening on http://" + config.bindAddress() + ":" + config.port()
                    + " worlds=" + config.allowedWorlds());
        } catch (ClassNotFoundException e) {
            portal = null;
            log("portal classes not packaged (production build); listener not started");
            startup(log, "disabled", "portal_not_packaged", "production build excludes portal classes");
        } catch (InvocationTargetException e) {
            portal = null;
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            log("portal start failed: " + cause);
            startup(log, "error", "start_failed", String.valueOf(cause));
        } catch (Throwable t) {
            portal = null;
            log("portal start failed: " + t);
            startup(log, "error", "start_failed", String.valueOf(t));
        }
    }

    private static void onServerStopping(ServerStoppingEvent event) {
        Object service = portal;
        portal = null;
        if (service != null) {
            try {
                service.getClass().getMethod("stop").invoke(service);
                log("portal stopped");
            } catch (Throwable t) {
                log("portal stop failed: " + t);
            }
        }
        AuditLog log = audit;
        if (log != null) {
            Map<String, Object> fields = new LinkedHashMap<>();
            fields.put("event", "shutdown");
            fields.put("decision", "stopped");
            safeAppend(log, fields);
        }
        audit = null;
        observe = null;
        snapshots = null;
    }

    private static void startup(AuditLog log, String decision, String code, String detail) {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("event", "startup");
        fields.put("decision", decision);
        fields.put("code", code);
        if (detail != null) fields.put("detail", detail);
        safeAppend(log, fields);
    }

    private static void safeAppend(AuditLog log, Map<String, Object> fields) {
        try {
            log.append(fields);
        } catch (Throwable t) {
            log("audit write failed: " + t);
        }
    }

    private static void log(String message) {
        System.out.println("[numen_groundtruth] " + message);
    }
}
