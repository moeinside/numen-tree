package numentree.devtools;

import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.server.MinecraftServer;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;

import numentree.devtools.audit.AuditLog;
import numentree.devtools.portal.PortalCore;
import numentree.devtools.security.TokenStore;

/**
 * Numen Tree DevTools: dev-only GM command portal.
 *
 * <p>Disabled by default. When {@code config/numen-devtools.json} has
 * {@code enabled=true}, the mod reads a bearer token from
 * {@code config/numen-devtools.token} and listens on 127.0.0.1:8770. Commands
 * must pass the root allowlist and test-world allowlist, and are dispatched on
 * the server thread with permission level 4.</p>
 *
 * <p>The portal implementation is loaded reflectively so a production build can
 * omit {@code numentree.devtools.portal} entirely.</p>
 */
@Mod("numen_devtools")
public final class DevToolsMod {
    private static final String VERSION = PortalCore.VERSION;
    private static final String PORTAL_CLASS = "numentree.devtools.portal.PortalService";

    private static volatile Object portal;
    private static volatile AuditLog audit;
    private static volatile Path gameDir;

    public DevToolsMod() {
        IEventBus bus = NeoForge.EVENT_BUS;
        bus.addListener(DevToolsMod::onServerStarted);
        bus.addListener(DevToolsMod::onServerStopping);
        log("v" + VERSION + " loaded (dev-only GM portal; default disabled)");
    }

    private static void onServerStarted(ServerStartedEvent event) {
        MinecraftServer server = event.getServer();
        gameDir = server.getServerDirectory();
        DevToolsConfig config;
        try {
            config = DevToolsConfig.load(gameDir);
        } catch (Throwable t) {
            log("config load failed; portal stays disabled: " + t);
            return;
        }
        if (!config.enabled()) {
            log("disabled (config/numen-devtools.json enabled=false)");
            return;
        }
        List<String> problems = config.validateForServer();
        if (!problems.isEmpty()) {
            log("refusing to start: " + String.join("; ", problems));
            return;
        }

        AuditLog log = new AuditLog(gameDir.resolve("logs/numen-devtools-audit.jsonl"));
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
                    MinecraftServer.class, DevToolsConfig.class, AuditLog.class, TokenStore.class);
            Object service = ctor.newInstance(server, config, log, tokens);
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
        System.out.println("[numen_devtools] " + message);
    }
}
