package numenlockfix;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.neoforge.event.entity.living.LivingDeathEvent;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;

/**
 * Numen 僵尸锁清理补丁 v3（2026-11-08）。
 *
 * 背景：numen 的 ServerPrograms.RUNNING 是 JVM 静态表，程序没正常结束（切档/客户端死在调用途中/
 * 死亡打断在途调用）就会把该同伴的 UUID 永久留在表里，之后任何 lua 调用都被拒：
 *   "a program is already running for this companion, or its built-in brain is acting"
 *
 * v3 在 v2（启动清 / 死亡定向清 / /numenlockfix）基础上新增：
 *   1) **本地控制端口 127.0.0.1:8768**——树进程可以 GET /status、POST /unlock?uuid=...&all=1，
 *      不需要玩家在游戏里敲命令，也不需要重启游戏/重建同伴；
 *   2) 清锁走 numen 自己的公开 API cutOff(uuid, programId, false) 先 cancel 程序，再删表项；
 *   3) 反射失败不再静默：日志明确写 foundClass / 每个事件清了几个；启动即打一行版本+状态；
 *   4) 多重类加载器兜底（patch 自己的 loader、context loader、numen 锚点类的 loader）。
 *
 * 不修改 numen 本体：只反射一个私有静态 Map + 调用公开静态方法；删 jar 即回滚。
 */
@Mod("numenlockfix")
public final class NumenLockFix {

    private static final String VERSION = "1.2.0";
    private static final String CLS = "com.dwinovo.numen.program.ServerPrograms";
    private static final String FIELD = "RUNNING";
    private static final String DISPATCH_CLS = "com.dwinovo.numen.task.CompanionTickDispatcher";
    private static final String PLAYER_CLS = "com.dwinovo.numen.entity.NumenPlayer";
    private static final String PERSIST_CLS = "com.dwinovo.numen.task.TaskPersistence";
    private static final int DEFAULT_PORT = 8768;

    private static volatile MinecraftServer server;
    private static Class<?> programsClass;
    private static Field runningField;
    private static Class<?> dispatcherClass;
    private static Class<?> playerClass;
    private static Class<?> persistenceClass;
    private static Method cancelForMethod;
    private static Method clearActiveTaskMethod;
    private static Method forgetMethod;
    private static Method findByUuidMethod;
    private static String lastFindError = "";
    private static String lastBrainError = "";
    private static boolean findTried = false;
    private static ServerSocket httpSocket;
    private static volatile int httpPort = DEFAULT_PORT;

    public NumenLockFix() {
        IEventBus bus = NeoForge.EVENT_BUS;
        bus.addListener(NumenLockFix::onServerStarted);
        bus.addListener(NumenLockFix::onServerStopping);
        bus.addListener(NumenLockFix::onLivingDeath);
        bus.addListener(NumenLockFix::onRegisterCommands);
        log("v" + VERSION + " 加载：目标=" + CLS + "，外部清锁端口=127.0.0.1:" + httpPort);
        startHttp();
    }

    // ── 生命周期 ────────────────────────────────────────────

    private static void onServerStarted(ServerStartedEvent event) {
        server = event.getServer();
        boolean found = ensure();
        int n = clearAll("server started");
        log("server started: foundClass=" + found + " RUNNING=" + n + (found ? "" : "（反射失败：" + lastFindError + "）"));
    }

    private static void onServerStopping(ServerStoppingEvent event) {
        server = null;
    }

    /** 同伴死亡：延迟 1 tick 清掉该 UUID（让 numen 自己的死亡收尾先跑完）。 */
    private static void onLivingDeath(LivingDeathEvent event) {
        try {
            Entity entity = event.getEntity();
            MinecraftServer srv = entity.getServer();
            UUID id = entity.getUUID();
            Runnable task = () -> {
                int n = clearOne(id);
                log("death: uuid=" + id + " cleared=" + n);
            };
            if (srv != null) srv.execute(task);
            else task.run();
        } catch (Throwable t) {
            log("死亡清理失败：" + t);
        }
    }

    private static void onRegisterCommands(RegisterCommandsEvent event) {
        event.getDispatcher().register(
            Commands.literal("numenlockfix")
                .requires(source -> source.hasPermission(2))
                .executes(ctx -> {
                    int n = clearAll("manual command");
                    ctx.getSource().sendSuccess(
                        () -> Component.literal("[numenlockfix] 清掉 " + n + " 个程序锁（v" + VERSION + "）"),
                        true
                    );
                    return Math.max(0, n);
                })
        );
    }

    // ── 反射：找到 ServerPrograms / RUNNING / cutOff ─────────

    private static synchronized boolean ensure() {
        if (runningField != null) return true;
        if (findTried && runningField == null) {
            // 之前失败过：每次调用再试一次（类加载器可能在服务器启动后才就绪）
        }
        findTried = true;
        Set<ClassLoader> loaders = new LinkedHashSet<>();
        addLoader(loaders, NumenLockFix.class.getClassLoader());
        addLoader(loaders, Thread.currentThread().getContextClassLoader());
        for (String anchor : new String[] {
            "com.dwinovo.numen.core.NumenCore",
            "com.dwinovo.numen.entity.NumenPlayer",
            "com.dwinovo.numen.mcp.server.McpServer",
            "com.dwinovo.numen.program.ServerPrograms$Running",
        }) {
            try {
                addLoader(loaders, Class.forName(anchor).getClassLoader());
            } catch (Throwable ignored) {
                // numen 没装 / 类名变化：继续
            }
        }
        StringBuilder tried = new StringBuilder();
        for (ClassLoader cl : loaders) {
            if (cl == null) continue;
            try {
                Class<?> c = Class.forName(CLS, true, cl);
                Field f = c.getDeclaredField(FIELD);
                f.setAccessible(true);
                programsClass = c;
                runningField = f;
                log("反射成功：loader=" + cl.getClass().getName());
                return true;
            } catch (Throwable t) {
                tried.append(cl.getClass().getSimpleName()).append("→").append(t.getClass().getSimpleName()).append("; ");
            }
        }
        lastFindError = tried.length() == 0 ? "没有可用的类加载器" : tried.toString();
        return false;
    }

    private static void addLoader(Set<ClassLoader> set, ClassLoader cl) {
        if (cl != null) set.add(cl);
    }

    // ── 反射：CompanionBrain 任务清理（v1.2 新增）────────────

    private static synchronized boolean ensureBrain() {
        if (dispatcherClass != null && cancelForMethod != null) return true;
        Set<ClassLoader> loaders = new LinkedHashSet<>();
        addLoader(loaders, NumenLockFix.class.getClassLoader());
        addLoader(loaders, Thread.currentThread().getContextClassLoader());
        for (String anchor : new String[] {
            "com.dwinovo.numen.entity.NumenPlayer",
            "com.dwinovo.numen.core.NumenCore",
            "com.dwinovo.numen.task.CompanionTickDispatcher",
        }) {
            try {
                addLoader(loaders, Class.forName(anchor).getClassLoader());
            } catch (Throwable ignored) {
                // 类名变化 / 没装：继续
            }
        }
        StringBuilder tried = new StringBuilder();
        for (ClassLoader cl : loaders) {
            if (cl == null) continue;
            try {
                Class<?> d = Class.forName(DISPATCH_CLS, true, cl);
                Class<?> p = Class.forName(PLAYER_CLS, true, cl);
                Class<?> ps = Class.forName(PERSIST_CLS, true, cl);
                Method cancel = d.getMethod("cancelFor", p);
                Method clear = d.getMethod("clearActiveTask", p);
                Method forget = ps.getMethod("forget", p);
                Method findByUuid = p.getMethod("findByUuid", MinecraftServer.class, UUID.class);
                dispatcherClass = d;
                playerClass = p;
                persistenceClass = ps;
                cancelForMethod = cancel;
                clearActiveTaskMethod = clear;
                forgetMethod = forget;
                findByUuidMethod = findByUuid;
                log("brain 反射成功：loader=" + cl.getClass().getName());
                return true;
            } catch (Throwable t) {
                tried.append(cl.getClass().getSimpleName()).append("→").append(t.getClass().getSimpleName()).append("; ");
            }
        }
        lastBrainError = tried.length() == 0 ? "没有可用的类加载器" : tried.toString();
        return false;
    }

    /** 找到目标同伴（UUID 为空则所有 NumenPlayer）。 */
    private static List<Object> findPlayers(UUID id) throws Exception {
        List<Object> out = new ArrayList<>();
        MinecraftServer srv = server;
        if (srv == null) return out;
        if (id != null && findByUuidMethod != null) {
            Object p = findByUuidMethod.invoke(null, srv, id);
            if (p != null) out.add(p);
        }
        if (!out.isEmpty()) return out;
        for (ServerLevel level : srv.getAllLevels()) {
            for (Entity e : level.getAllEntities()) {
                if (playerClass != null && playerClass.isInstance(e)) {
                    if (id == null || e.getUUID().equals(id)) out.add(e);
                }
            }
        }
        return out;
    }

    /** 在服务器线程清除同伴的内置脑/任务槽（不删实体、不丢背包）。 */
    private static String resetBrainJson(Map<String, String> params) {
        boolean all = "1".equals(params.get("all")) || "true".equalsIgnoreCase(params.get("all"));
        String uuidStr = params.get("uuid");
        UUID id = null;
        if (uuidStr != null && !uuidStr.isBlank()) {
            try {
                id = UUID.fromString(uuidStr.trim());
            } catch (Throwable t) {
                return "{\"ok\":false,\"error\":\"bad uuid\"}";
            }
        }
        if (!all && id == null) return "{\"ok\":false,\"error\":\"need uuid / all=1\"}";
        if (!ensureBrain()) {
            return "{\"ok\":false,\"patch\":\"" + VERSION + "\",\"brainReady\":false,\"error\":\""
                + escape(lastBrainError) + "\"}";
        }
        final UUID target = id;
        final boolean allFlag = all;
        int[] result = new int[] { -999 };
        int[] players = new int[] { 0 };
        String[] err = new String[] { null };
        MinecraftServer srv = server;
        Runnable task = () -> {
            try {
                List<Object> list = allFlag ? findPlayers(null) : findPlayers(target);
                players[0] = list.size();
                int n = 0;
                for (Object p : list) {
                    try {
                        cancelForMethod.invoke(null, p);
                        clearActiveTaskMethod.invoke(null, p);
                        forgetMethod.invoke(null, p);
                        n += 1;
                    } catch (Throwable t) {
                        err[0] = String.valueOf(t);
                    }
                }
                result[0] = n;
            } catch (Throwable t) {
                result[0] = -2;
                err[0] = String.valueOf(t);
            }
        };
        if (srv != null) {
            CountDownLatch latch = new CountDownLatch(1);
            srv.execute(() -> {
                try {
                    task.run();
                } finally {
                    latch.countDown();
                }
            });
            try {
                latch.await(2, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        } else {
            task.run();
        }
        log("http reset-brain uuid=" + target + " all=" + allFlag + " players=" + players[0]
            + " reset=" + result[0] + (err[0] != null ? " err=" + err[0] : ""));
        if (result[0] < 0) {
            return "{\"ok\":false,\"patch\":\"" + VERSION + "\",\"error\":\""
                + escape(err[0] == null ? "reset threw" : err[0]) + "\"}";
        }
        return "{\"ok\":true,\"patch\":\"" + VERSION + "\",\"players\":" + players[0]
            + ",\"reset\":" + result[0]
            + (err[0] != null ? ",\"error\":\"" + escape(err[0]) + "\"" : "") + "}";
    }

    @SuppressWarnings("unchecked")
    private static Map<Object, Object> runningMap() throws Exception {
        if (!ensure()) throw new IllegalStateException("找不到 " + CLS + "（" + lastFindError + "）");
        Object v = runningField.get(null);
        if (v instanceof Map<?, ?> m) return (Map<Object, Object>) m;
        throw new IllegalStateException("RUNNING 不是 Map");
    }

    /** 读 Running 的某个字段（失败返回 null）。 */
    private static Object fieldOf(Object running, String name) {
        try {
            Field f = running.getClass().getDeclaredField(name);
            f.setAccessible(true);
            return f.get(running);
        } catch (Throwable t) {
            return null;
        }
    }

    // ── 清理 ────────────────────────────────────────────────

    private static int clearAll(String when) {
        try {
            Map<Object, Object> map = runningMap();
            int n = map.size();
            if (n > 0) {
                List<Object> keys = new ArrayList<>(map.keySet());
                for (Object k : keys) {
                    if (k instanceof UUID u) clearOne(u);
                }
                map.clear();
                log("清空 RUNNING：" + n + " 个（" + when + "）");
            }
            return n;
        } catch (Throwable t) {
            log("清理失败（" + when + "）：" + t);
            return 0;
        }
    }

    /** 清指定 UUID；返回 1=确实清掉了，0=表里没有，-1=反射不可用。 */
    private static int clearOne(UUID id) {
        try {
            Map<Object, Object> map = runningMap();
            Object running = map.get(id);
            if (running == null) return 0;
            // 先走 numen 公开 API：cutOff(uuid, programId, false) → Program.cancel(false)
            try {
                Object programId = fieldOf(running, "programId");
                if (programId != null && programsClass != null) {
                    Method cutOff = programsClass.getMethod("cutOff", UUID.class, String.class, boolean.class);
                    cutOff.invoke(null, id, String.valueOf(programId), false);
                }
            } catch (Throwable t) {
                log("cutOff 调用失败（继续删表项）：" + t);
            }
            map.remove(id);
            return 1;
        } catch (Throwable t) {
            log("定向清理失败：" + t);
            return -1;
        }
    }

    /** 按 UUID 清（表键或 Running.companion 匹配）；返回清掉的个数。 */
    private static int unlockByUuid(UUID id) {
        int n = clearOne(id);
        if (n != 0) return Math.max(n, 0);
        // 表键可能不是同伴 UUID：扫一遍 Running.companion
        try {
            Map<Object, Object> map = runningMap();
            List<Object> keys = new ArrayList<>(map.keySet());
            for (Object k : keys) {
                Object running = map.get(k);
                Object companion = fieldOf(running, "companion");
                if (companion instanceof UUID u && u.equals(id)) {
                    map.remove(k);
                    n += 1;
                }
            }
        } catch (Throwable t) {
            log("按 companion 清理失败：" + t);
        }
        return n;
    }

    // ── 本地控制端口（给树进程用，只绑 127.0.0.1）───────────

    private static void startHttp() {
        String prop = System.getProperty("numenlockfix.port");
        if (prop != null && !prop.isBlank()) {
            try {
                httpPort = Integer.parseInt(prop.trim());
            } catch (NumberFormatException ignored) {
                // 保持默认
            }
        }
        Thread t = new Thread(NumenLockFix::httpLoop, "numenlockfix-http");
        t.setDaemon(true);
        t.start();
    }

    private static void httpLoop() {
        try {
            httpSocket = new ServerSocket();
            httpSocket.setReuseAddress(true);
            httpSocket.bind(new InetSocketAddress("127.0.0.1", httpPort));
            log("控制端口已监听：http://127.0.0.1:" + httpPort + "/status");
        } catch (Throwable e) {
            log("控制端口绑定失败（树侧自动清锁会不可用）：" + e);
            return;
        }
        while (true) {
            try (Socket s = httpSocket.accept()) {
                s.setSoTimeout(5000);
                handleHttp(s);
            } catch (Throwable e) {
                // 单次请求失败不退出
            }
        }
    }

    private static void handleHttp(Socket s) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
        String requestLine = in.readLine();
        if (requestLine == null) return;
        int contentLength = 0;
        for (String line; (line = in.readLine()) != null && !line.isEmpty(); ) {
            int idx = line.indexOf(':');
            if (idx > 0 && line.substring(0, idx).trim().equalsIgnoreCase("content-length")) {
                try {
                    contentLength = Integer.parseInt(line.substring(idx + 1).trim());
                } catch (NumberFormatException ignored) {
                    // ignore
                }
            }
        }
        char[] body = new char[Math.max(0, Math.min(contentLength, 4096))];
        if (body.length > 0) {
            int read = 0;
            while (read < body.length) {
                int n = in.read(body, read, body.length - read);
                if (n < 0) break;
                read += n;
            }
        }
        String[] parts = requestLine.split(" ");
        String method = parts.length > 0 ? parts[0].toUpperCase() : "GET";
        String target = parts.length > 1 ? parts[1] : "/";
        int q = target.indexOf('?');
        String path = q >= 0 ? target.substring(0, q) : target;
        String query = q >= 0 ? target.substring(q + 1) : "";
        Map<String, String> params = parseQuery(query);

        String json;
        if (path.equals("/status") || path.equals("/lock/status")) {
            json = statusJson();
        } else if ((path.equals("/unlock") || path.equals("/lock/unlock")) && method.equals("POST")) {
            json = unlockJson(params);
        } else if ((path.equals("/reset-brain") || path.equals("/brain/reset")) && method.equals("POST")) {
            json = resetBrainJson(params);
        } else {
            json = "{\"ok\":false,\"error\":\"unknown endpoint\"}";
        }
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        OutputStream out = s.getOutputStream();
        PrintWriter w = new PrintWriter(new java.io.OutputStreamWriter(out, StandardCharsets.UTF_8), false);
        w.print("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n");
        w.print("Content-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n");
        w.flush();
        out.write(bytes);
        out.flush();
    }

    private static Map<String, String> parseQuery(String query) {
        java.util.LinkedHashMap<String, String> out = new java.util.LinkedHashMap<>();
        if (query == null || query.isEmpty()) return out;
        for (String kv : query.split("&")) {
            int eq = kv.indexOf('=');
            String k = eq >= 0 ? kv.substring(0, eq) : kv;
            String v = eq >= 0 ? kv.substring(eq + 1) : "";
            try {
                out.put(java.net.URLDecoder.decode(k, "UTF-8"), java.net.URLDecoder.decode(v, "UTF-8"));
            } catch (Throwable ignored) {
                out.put(k, v);
            }
        }
        return out;
    }

    private static String statusJson() {
        boolean found = ensure();
        List<String> entries = new ArrayList<>();
        int count = 0;
        if (found) {
            try {
                Map<Object, Object> map = runningMap();
                count = map.size();
                for (Map.Entry<Object, Object> e : map.entrySet()) {
                    Object running = e.getValue();
                    entries.add("{"
                        + "\"key\":\"" + e.getKey() + "\","
                        + "\"program\":\"" + escape(String.valueOf(fieldOf(running, "programId"))) + "\","
                        + "\"companion\":\"" + fieldOf(running, "companion") + "\","
                        + "\"owner\":\"" + fieldOf(running, "owner") + "\""
                        + "}");
                }
            } catch (Throwable t) {
                return "{\"ok\":false,\"patch\":\"" + VERSION + "\",\"error\":\"" + escape(String.valueOf(t)) + "\"}";
            }
        }
        return "{\"ok\":true,\"patch\":\"" + VERSION + "\",\"foundClass\":" + found
            + ",\"port\":" + httpPort + ",\"count\":" + count
            + ",\"brainReady\":" + ensureBrain()
            + (ensureBrain() ? "" : ",\"brainError\":\"" + escape(lastBrainError) + "\"")
            + ",\"running\":[" + String.join(",", entries) + "]"
            + (found ? "" : ",\"findError\":\"" + escape(lastFindError) + "\"") + "}";
    }

    private static String unlockJson(Map<String, String> params) {
        boolean all = "1".equals(params.get("all")) || "true".equalsIgnoreCase(params.get("all"));
        String uuidStr = params.get("uuid");
        UUID id = null;
        if (uuidStr != null && !uuidStr.isBlank()) {
            try {
                id = UUID.fromString(uuidStr.trim());
            } catch (Throwable t) {
                return "{\"ok\":false,\"error\":\"bad uuid\"}";
            }
        }
        if (!all && id == null) {
            return "{\"ok\":false,\"error\":\"need uuid / all=1\"}";
        }
        if (!ensure()) {
            return "{\"ok\":false,\"foundClass\":false,\"error\":\"" + escape(lastFindError) + "\"}";
        }

        // 尽量在服务器线程上做；做不了就直接做（同 JVM，Map 本身是并发容器有风险但接受）
        final UUID target = id;
        final boolean allFlag = all;
        int[] result = new int[] { -999 };
        MinecraftServer srv = server;
        Runnable task = () -> {
            try {
                result[0] = allFlag ? clearAll("http") : unlockByUuid(target);
            } catch (Throwable t) {
                result[0] = -2;
            }
        };
        if (srv != null) {
            CountDownLatch latch = new CountDownLatch(1);
            srv.execute(() -> {
                try {
                    task.run();
                } finally {
                    latch.countDown();
                }
            });
            try {
                latch.await(2, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        } else {
            task.run();
        }
        log("http unlock uuid=" + target + " all=" + allFlag + " cleared=" + result[0]);
        if (result[0] < -1) {
            return "{\"ok\":false,\"patch\":\"" + VERSION + "\",\"error\":\"clear threw\"}";
        }
        return "{\"ok\":true,\"patch\":\"" + VERSION + "\",\"cleared\":" + Math.max(0, result[0]) + "}";
    }

    private static String escape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "");
    }

    private static void log(String msg) {
        System.out.println("[numenlockfix] " + msg);
    }
}
