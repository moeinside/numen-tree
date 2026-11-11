package numentree.devtools.portal;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import net.minecraft.commands.CommandSourceStack;
import net.minecraft.server.MinecraftServer;

import numentree.devtools.CommandOutcome;
import numentree.devtools.CommandSink;
import numentree.devtools.DevToolsConfig;
import numentree.devtools.audit.AuditLog;
import numentree.devtools.security.CommandPolicy;
import numentree.devtools.security.TokenStore;

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
    private PortalCore core;

    public PortalService(MinecraftServer server, DevToolsConfig config, AuditLog audit, TokenStore tokens) {
        this.server = server;
        this.config = config;
        this.audit = audit;
        this.tokens = tokens;
    }

    public void start() throws Exception {
        core = new PortalCore(config, new ServerCommandSink(), audit, tokens);
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
