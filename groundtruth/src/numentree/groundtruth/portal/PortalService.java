package numentree.groundtruth.portal;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.ai.targeting.TargetingConditions;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.entity.EntityTypeTest;
import net.minecraft.world.phys.AABB;

import numentree.groundtruth.CommandOutcome;
import numentree.groundtruth.CommandSink;
import numentree.groundtruth.DevToolsConfig;
import numentree.groundtruth.audit.AuditLog;
import numentree.groundtruth.security.CommandPolicy;
import numentree.groundtruth.security.TokenStore;
import numentree.groundtruth.observe.ObserveStore;
import numentree.groundtruth.observe.QuerySink;
import numentree.groundtruth.observe.SnapshotStore;
import numentree.groundtruth.observe.StateSink;

/**
 * Minecraft adapter: starts {@link PortalCore} and executes commands on the
 * server thread with permission level 4 and suppressed output.
 *
 * <p>Loaded reflectively from {@code DevToolsMod} so a production jar can omit
 * this whole package without breaking mod loading.</p>
 */
public final class PortalService {
    private static final long COMMAND_TIMEOUT_MS = 5_000L;

    private final MinecraftServer server;
    private final DevToolsConfig config;
    private final AuditLog audit;
    private final TokenStore tokens;
    private final ObserveStore observe;
    private final SnapshotStore snapshots;
    private PortalCore core;

    public PortalService(MinecraftServer server, DevToolsConfig config, AuditLog audit, TokenStore tokens) {
        this(server, config, audit, tokens, null, null);
    }

    public PortalService(MinecraftServer server, DevToolsConfig config, AuditLog audit, TokenStore tokens,
                         ObserveStore observe) {
        this(server, config, audit, tokens, observe, null);
    }

    public PortalService(MinecraftServer server, DevToolsConfig config, AuditLog audit, TokenStore tokens,
                         ObserveStore observe, SnapshotStore snapshots) {
        this.server = server;
        this.config = config;
        this.audit = audit;
        this.tokens = tokens;
        this.observe = observe;
        this.snapshots = snapshots;
    }

    public void start() throws Exception {
        core = new PortalCore(config, new ServerCommandSink(), audit, tokens,
                new numentree.groundtruth.security.RateLimiter(config.maxPerMinute()), observe, snapshots,
                this::captureRegion, new ServerQuerySink(), null, this::applyState);
        core.start();
    }

    public void stop() {
        if (core != null) {
            core.stop();
            core = null;
        }
    }

    public int port() {
        return core == null ? -1 : core.port();
    }

    private Map<String, String> captureRegion(SnapshotStore.Region region) throws Exception {
        return onServer(() -> {
            Map<String, String> blocks = new LinkedHashMap<>();
            Level level = server.overworld();
            for (int x = region.x() - region.rx(); x <= region.x() + region.rx(); x++) {
                for (int y = region.y() - region.ry(); y <= region.y() + region.ry(); y++) {
                    for (int z = region.z() - region.rz(); z <= region.z() + region.rz(); z++) {
                        BlockPos pos = new BlockPos(x, y, z);
                        BlockState state = level.getBlockState(pos);
                        blocks.put(x + "," + y + "," + z,
                                BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
                    }
                }
            }
            return blocks;
        });
    }

    private <T> T onServer(Callable<T> task) throws Exception {
        if (!server.isRunning()) throw new IllegalStateException("server is not running");
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<T> result = new AtomicReference<>();
        AtomicReference<Throwable> error = new AtomicReference<>();
        server.execute(() -> {
            try {
                result.set(task.call());
            } catch (Throwable t) {
                error.set(t);
            } finally {
                done.countDown();
            }
        });
        if (!done.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("query timeout");
        if (error.get() != null) throw new IllegalStateException(safeMessage(error.get()));
        return result.get();
    }

    private Map<String, Object> applyState(String action, String target, double value,
                                          double x, double y, double z) throws Exception {
        CommandPolicy.WorldCheck wc = CommandPolicy.checkWorld(
                server.getWorldData().getLevelName(), config.allowedWorlds());
        if (!wc.allowed()) throw new IllegalStateException(wc.code() + ": " + wc.message());
        return onServer(() -> {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("action", action);
            out.put("target", target);
            if ("kill_tag".equals(action)) {
                int killed = 0;
                for (ServerLevel level : server.getAllLevels()) {
                    for (Entity entity : allEntities(level)) {
                        if (entity.getTags().contains(target)) {
                            entity.discard();
                            killed += 1;
                        }
                    }
                }
                out.put("count", killed);
                return out;
            }
            Entity entity = findEntity(target);
            if (entity == null) throw new IllegalStateException("target not found: " + target);
            if ("teleport".equals(action)) {
                entity.teleportTo(x, y, z);
                out.put("x", x);
                out.put("y", y);
                out.put("z", z);
                return out;
            }
            if (!(entity instanceof LivingEntity living)) {
                throw new IllegalStateException("target is not living: " + target);
            }
            if ("set_health".equals(action)) {
                double hp = Math.max(0, Math.min(value, living.getMaxHealth()));
                living.setHealth((float) hp);
                out.put("hp", living.getHealth());
                return out;
            }
            if ("set_food".equals(action)) {
                if (!(living instanceof Player player)) {
                    throw new IllegalStateException("target is not a player: " + target);
                }
                int food = (int) Math.max(0, Math.min(value, 20));
                player.getFoodData().setFoodLevel(food);
                out.put("food", player.getFoodData().getFoodLevel());
                return out;
            }
            if ("damage".equals(action)) {
                living.hurt(server.overworld().damageSources().generic(), (float) value);
                out.put("hp", living.getHealth());
                return out;
            }
            throw new IllegalStateException("unknown action: " + action);
        });
    }

    private Entity findEntity(String target) {
        for (ServerLevel level : server.getAllLevels()) {
            for (Entity entity : allEntities(level)) {
                if (entity.getUUID().toString().equalsIgnoreCase(target)
                        || entity.getName().getString().equals(target)) {
                    return entity;
                }
            }
        }
        return null;
    }

    private static List<Entity> allEntities(ServerLevel level) {
        AABB box = new AABB(-3.0E7, -256, -3.0E7, 3.0E7, 512, 3.0E7);
        return level.getEntities(EntityTypeTest.forClass(Entity.class), box, e -> true);
    }

    private final class ServerQuerySink implements QuerySink {        @Override
        public Map<String, Object> blockAt(int x, int y, int z) throws Exception {
            return onServer(() -> {
                BlockState state = server.overworld().getBlockState(new BlockPos(x, y, z));
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("x", x);
                m.put("y", y);
                m.put("z", z);
                m.put("block", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
                m.put("blockEntity", state.hasBlockEntity());
                return m;
            });
        }

        @Override
        public Map<String, Object> scanBox(SnapshotStore.Region region) throws Exception {
            return onServer(() -> {
                List<Map<String, Object>> blocks = new ArrayList<>(region.volume());
                Level level = server.overworld();
                for (int x = region.x() - region.rx(); x <= region.x() + region.rx(); x++) {
                    for (int y = region.y() - region.ry(); y <= region.y() + region.ry(); y++) {
                        for (int z = region.z() - region.rz(); z <= region.z() + region.rz(); z++) {
                            BlockState state = level.getBlockState(new BlockPos(x, y, z));
                            Map<String, Object> m = new LinkedHashMap<>();
                            m.put("x", x);
                            m.put("y", y);
                            m.put("z", z);
                            m.put("block", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
                            blocks.add(m);
                        }
                    }
                }
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("volume", region.volume());
                out.put("blocks", blocks);
                return out;
            });
        }

        @Override
        public Map<String, Object> entitiesIn(SnapshotStore.Region region) throws Exception {
            return onServer(() -> {
                Level level = server.overworld();
                AABB box = new AABB(
                        region.x() - region.rx(), region.y() - region.ry(), region.z() - region.rz(),
                        region.x() + region.rx() + 1.0, region.y() + region.ry() + 1.0,
                        region.z() + region.rz() + 1.0);
                List<Map<String, Object>> entities = new ArrayList<>();
                for (Entity entity : level.getEntitiesOfClass(Entity.class, box)) {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("entityId", entity.getUUID().toString());
                    m.put("entityType", BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString());
                    m.put("x", entity.getX());
                    m.put("y", entity.getY());
                    m.put("z", entity.getZ());
                    entities.add(m);
                }
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("count", entities.size());
                out.put("entities", entities);
                return out;
            });
        }

        @Override
        public Map<String, Object> lightAt(int x, int y, int z) throws Exception {
            return onServer(() -> {
                Level level = server.overworld();
                BlockPos pos = new BlockPos(x, y, z);
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("x", x);
                m.put("y", y);
                m.put("z", z);
                m.put("blockLight", level.getBrightness(LightLayer.BLOCK, pos));
                m.put("skyLight", level.getBrightness(LightLayer.SKY, pos));
                return m;
            });
        }
    }

    private final class ServerCommandSink implements CommandSink {
        @Override
        public CommandOutcome execute(String command) throws Exception {
            String world = server.getWorldData().getLevelName();
            CommandPolicy.WorldCheck worldCheck =
                    CommandPolicy.checkWorld(world, config.allowedWorlds());
            if (!worldCheck.allowed()) {
                return CommandOutcome.error(world, worldCheck.code(), worldCheck.message());
            }
            if (!server.isRunning()) {
                return CommandOutcome.error(world, "server_not_ready", "server is not running");
            }

            CountDownLatch done = new CountDownLatch(1);
            AtomicReference<CommandOutcome> outcome = new AtomicReference<>();
            AtomicBoolean submitted = new AtomicBoolean(false);
            try {
                server.execute(() -> {
                    submitted.set(true);
                    try {
                        outcome.set(runOnServerThread(command, world));
                    } catch (Throwable t) {
                        outcome.set(CommandOutcome.error(world, "command_failed",
                                safeMessage(t)));
                    } finally {
                        done.countDown();
                    }
                });
            } catch (Throwable t) {
                return CommandOutcome.error(world, "execution_failed",
                        "server rejected task: " + safeMessage(t));
            }
            if (!done.await(COMMAND_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                return CommandOutcome.error(world, "timeout",
                        "command did not finish within " + COMMAND_TIMEOUT_MS + " ms");
            }
            CommandOutcome result = outcome.get();
            if (result == null) {
                return CommandOutcome.error(world, "execution_failed",
                        "server thread produced no outcome (submitted=" + submitted.get() + ")");
            }
            return result;
        }

        private CommandOutcome runOnServerThread(String command, String world) {
            AtomicInteger result = new AtomicInteger(0);
            AtomicBoolean success = new AtomicBoolean(false);
            CommandSourceStack source = server.createCommandSourceStack()
                    .withPermission(4)
                    .withSuppressedOutput()
                    .withCallback((ok, value) -> {
                        success.set(ok);
                        result.set(value);
                    });
            server.getCommands().performPrefixedCommand(source, command);
            if (!success.get()) {
                return CommandOutcome.error(world, "command_failed",
                        "dispatcher rejected command (syntax/selector/permission); see server log");
            }
            return CommandOutcome.ok(world, result.get(), List.of());
        }
    }

    private static String safeMessage(Throwable t) {
        String m = t.getMessage();
        String s = t.getClass().getSimpleName() + (m == null ? "" : ": " + m);
        return s.length() > 500 ? s.substring(0, 500) : s;
    }
}
