package numentree.tentacle;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.animal.Animal;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;

/**
 * Numen Tree Tentacle v0.1：树的只读触手。
 *
 * 只做具身感知：
 *  - 自身状态、朝向、时间、脚下光照
 *  - 附近实体（距离/FOV/视线遮挡/敌对分类）
 *  - 附近地标（箱子/床/火把/工作台/熔炉）
 *
 * 不做：移动、战斗、合成、决策、改世界。
 * 本地端口 127.0.0.1:8769（-Dnumen_tree_tentacle.port=8769 可改）。
 */
@Mod("numen_tree_tentacle")
public final class NumenTreeTentacle {
    private static final String VERSION = "0.3.0";
    private static final int DEFAULT_PORT = 8769;

    private static volatile MinecraftServer server;
    private static ServerSocket socket;
    private static volatile int port = DEFAULT_PORT;

    public NumenTreeTentacle() {
        IEventBus bus = NeoForge.EVENT_BUS;
        bus.addListener(NumenTreeTentacle::onServerStarted);
        bus.addListener(NumenTreeTentacle::onServerStopping);
        log("v" + VERSION + " 加载：只读触手端口=127.0.0.1:" + port);
        startHttp();
    }

    private static void onServerStarted(ServerStartedEvent event) {
        server = event.getServer();
        log("server started: tentacle ready");
    }

    private static void onServerStopping(ServerStoppingEvent event) {
        server = null;
    }

    private static void startHttp() {
        String prop = System.getProperty("numen_tree_tentacle.port");
        if (prop != null && !prop.isBlank()) {
            try {
                port = Integer.parseInt(prop.trim());
            } catch (NumberFormatException ignored) {
                // keep default
            }
        }
        Thread t = new Thread(NumenTreeTentacle::httpLoop, "numen-tree-tentacle-http");
        t.setDaemon(true);
        t.start();
    }

    private static void httpLoop() {
        try {
            socket = new ServerSocket();
            socket.setReuseAddress(true);
            socket.bind(new InetSocketAddress("127.0.0.1", port));
            log("控制端口已监听：http://127.0.0.1:" + port + "/perception");
        } catch (Throwable e) {
            log("端口绑定失败：" + e);
            return;
        }
        while (true) {
            try (Socket s = socket.accept()) {
                s.setSoTimeout(5000);
                handle(s);
            } catch (Throwable ignored) {
                // single request failure shouldn't kill the listener
            }
        }
    }

    private static void handle(Socket s) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
        String line = in.readLine();
        if (line == null) return;
        String[] parts = line.split(" ");
        String method = parts.length > 0 ? parts[0].toUpperCase() : "GET";
        String target = parts.length > 1 ? parts[1] : "/";
        int q = target.indexOf('?');
        String path = q >= 0 ? target.substring(0, q) : target;
        String query = q >= 0 ? target.substring(q + 1) : "";

        String json;
        if (!method.equals("GET")) {
            json = "{\"ok\":false,\"error\":\"read-only: only GET\"}";
        } else if (path.equals("/health") || path.equals("/status")) {
            json = "{\"ok\":true,\"mod\":\"numen_tree_tentacle\",\"version\":\"" + VERSION
                + "\",\"port\":" + port + ",\"server\":" + (server != null) + "}";
        } else if (path.equals("/perception")) {
            json = perception(query);
        } else {
            json = "{\"ok\":false,\"error\":\"unknown endpoint\"}";
        }

        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        OutputStream out = s.getOutputStream();
        out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: "
            + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    // ── perception ─────────────────────────────────────────

    private static String perception(String query) {
        UUID id = null;
        double radius = 16;
        int limit = 20;
        double fov = 100;
        for (String kv : query.split("&")) {
            int eq = kv.indexOf('=');
            if (eq <= 0) continue;
            String k = kv.substring(0, eq);
            String v = kv.substring(eq + 1);
            try {
                if (k.equals("uuid")) id = UUID.fromString(v);
                else if (k.equals("radius")) radius = Math.max(4, Math.min(48, Double.parseDouble(v)));
                else if (k.equals("limit")) limit = Math.max(1, Math.min(30, Integer.parseInt(v)));
                else if (k.equals("fov")) fov = Math.max(30, Math.min(180, Double.parseDouble(v)));
            } catch (Throwable ignored) {
                // ignore bad params
            }
        }
        if (id == null) return "{\"ok\":false,\"error\":\"need uuid\"}";
        if (server == null) return "{\"ok\":false,\"error\":\"server not ready\"}";

        final UUID target = id;
        final double r = radius;
        final int lim = limit;
        final double f = fov;
        String[] out = new String[1];
        CountDownLatch latch = new CountDownLatch(1);
        server.execute(() -> {
            try {
                out[0] = buildPerception(target, r, lim, f);
            } catch (Throwable t) {
                out[0] = "{\"ok\":false,\"error\":\"" + esc(String.valueOf(t)) + "\"}";
            } finally {
                latch.countDown();
            }
        });
        try {
            latch.await(2, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return out[0] != null ? out[0] : "{\"ok\":false,\"error\":\"server timeout\"}";
    }

    private static String buildPerception(UUID id, double radius, int limit, double fov) {
        ServerLevel level = null;
        Entity self = null;
        for (ServerLevel l : server.getAllLevels()) {
            for (Entity e : l.getAllEntities()) {
                if (e.getUUID().equals(id)) {
                    self = e;
                    level = l;
                    break;
                }
            }
            if (self != null) break;
        }
        if (self == null || level == null) return "{\"ok\":false,\"error\":\"entity not found\"}";
        final Entity me = self;

        boolean day = level.isDay();
        long dayTime = level.getDayTime() % 24000L;
        double maxRange = day ? radius : Math.min(radius, 16);
        BlockPos sp = self.blockPosition();
        int light = level.getMaxLocalRawBrightness(sp);

        StringBuilder sb = new StringBuilder(2048);
        sb.append("{\"ok\":true,\"mod\":\"numen_tree_tentacle\",\"version\":\"").append(VERSION).append("\"");
        sb.append(",\"tick\":").append(server.getTickCount());
        sb.append(",\"self\":{");
        sb.append("\"uuid\":\"").append(self.getUUID()).append("\"");
        sb.append(",\"name\":\"").append(esc(self.getName().getString())).append("\"");
        sb.append(",\"x\":").append(num(self.getX())).append(",\"y\":").append(num(self.getY()))
            .append(",\"z\":").append(num(self.getZ()));
        sb.append(",\"yaw\":").append(num(self.getYRot())).append(",\"pitch\":").append(num(self.getXRot()));
        sb.append(",\"hp\":").append(num(self instanceof LivingEntity le ? le.getHealth() : 0));
        sb.append(",\"max_hp\":").append(num(self instanceof LivingEntity le ? le.getMaxHealth() : 0));
        if (self instanceof ServerPlayer sp2) {
            sb.append(",\"food\":").append(sp2.getFoodData().getFoodLevel());
        } else {
            sb.append(",\"food\":null");
        }
        sb.append(",\"dimension\":\"").append(esc(level.dimension().location().toString())).append("\"");
        sb.append(",\"light\":").append(light).append(",\"day\":").append(day)
            .append(",\"day_time\":").append(dayTime).append("}");
        sb.append(",\"limits\":{\"radius\":").append(num(radius)).append(",\"vision_range\":")
            .append(num(maxRange)).append(",\"fov\":").append(num(fov)).append(",\"limit\":").append(limit).append("}");

        // v0.2 terrain：脚下/头顶/四方向可站立，水/岩浆/支撑
        appendTerrain(sb, level, self);
        // v0.3 水域/冰面
        appendWater(sb, level, self);

        // nearby entities: distance + FOV + line of sight
        double yawRad = Math.toRadians(self.getYRot());
        double fx = -Math.sin(yawRad);
        double fz = Math.cos(yawRad);
        List<Entity> found = new ArrayList<>();
        for (Entity e : level.getAllEntities()) {
            if (e == self || e.isRemoved()) continue;
            double dx = e.getX() - self.getX();
            double dy = e.getY() - self.getY();
            double dz = e.getZ() - self.getZ();
            double dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist > maxRange) continue;
            // FOV：4.5 格内视为触觉/近身，不做视角过滤
            if (dist > 4.5) {
                double len = Math.sqrt(dx * dx + dz * dz);
                if (len > 0.001) {
                    double dot = (dx / len) * fx + (dz / len) * fz;
                    double angle = Math.toDegrees(Math.acos(Math.max(-1, Math.min(1, dot))));
                    if (angle > fov / 2) continue;
                }
            }
            if (e instanceof LivingEntity le && self instanceof LivingEntity sle) {
                if (!sle.hasLineOfSight(e)) continue;
            }
            found.add(e);
        }
        found.sort(Comparator.comparingDouble(e -> e.distanceToSqr(me)));
        sb.append(",\"entities\":[");
        int n = 0;
        for (Entity e : found) {
            if (n >= limit) break;
            if (n > 0) sb.append(',');
            double dx = e.getX() - self.getX();
            double dz = e.getZ() - self.getZ();
            String category = e instanceof Monster ? "hostile"
                : e instanceof Animal ? "animal"
                : e instanceof Player ? "player" : "other";
            String type = net.minecraft.world.entity.EntityType.getKey(e.getType()).toString();
            sb.append("{\"id\":\"").append(e.getUUID()).append("\"")
                .append(",\"type\":\"").append(esc(type)).append("\"")
                .append(",\"category\":\"").append(category).append("\"")
                .append(",\"x\":").append(num(e.getX())).append(",\"y\":").append(num(e.getY()))
                .append(",\"z\":").append(num(e.getZ()))
                .append(",\"distance\":").append(num(Math.sqrt(dx * dx + dz * dz + (e.getY() - self.getY()) * (e.getY() - self.getY()))))
                .append(",\"hp\":").append(num(e instanceof LivingEntity le2 ? le2.getHealth() : 0))
                .append("}");
            n += 1;
        }
        sb.append("]");

        // nearby landmarks (small radius, read-only)
        List<Landmark> marks = new ArrayList<>();
        int lr = (int) Math.min(10, Math.max(4, radius));
        BlockPos min = sp.offset(-lr, -3, -lr);
        BlockPos max = sp.offset(lr, 4, lr);
        for (BlockPos p : BlockPos.betweenClosed(min, max)) {
            BlockState st = level.getBlockState(p);
            String kind = null;
            if (st.is(Blocks.CHEST) || st.is(Blocks.TRAPPED_CHEST) || st.is(Blocks.BARREL)) kind = "chest";
            else if (st.is(BlockTags.BEDS)) kind = "bed";
            else if (st.is(Blocks.TORCH) || st.is(Blocks.WALL_TORCH)) kind = "torch";
            else if (st.is(Blocks.CRAFTING_TABLE)) kind = "crafting_table";
            else if (st.is(Blocks.FURNACE)) kind = "furnace";
            if (kind != null) {
                marks.add(new Landmark(kind, p.immutable()));
            }
        }
        marks.sort(Comparator.comparingDouble(m -> m.pos.distSqr(sp)));
        sb.append(",\"landmarks\":[");
        int m = 0;
        for (Landmark mark : marks) {
            if (m >= 20) break;
            if (m > 0) sb.append(',');
            sb.append("{\"kind\":\"").append(mark.kind).append("\"")
                .append(",\"x\":").append(mark.pos.getX()).append(",\"y\":").append(mark.pos.getY())
                .append(",\"z\":").append(mark.pos.getZ())
                .append(",\"distance\":").append(num(Math.sqrt(mark.pos.distSqr(sp)))).append("}");
            m += 1;
        }
        sb.append("]}");
        return sb.toString();
    }

    private static void appendWater(StringBuilder sb, ServerLevel level, Entity self) {
        int r = 16;
        BlockPos feet = self.blockPosition();
        int openCount = 0;
        int iceCount = 0;
        BlockPos nearestOpen = null;
        BlockPos nearestIce = null;
        double nearestOpenD = Double.MAX_VALUE;
        double nearestIceD = Double.MAX_VALUE;
        for (BlockPos p : BlockPos.betweenClosed(feet.offset(-r, -4, -r), feet.offset(r, 3, r))) {
            BlockState st = level.getBlockState(p);
            if (st.is(Blocks.WATER)) {
                BlockState above = level.getBlockState(p.above());
                if (above.isAir()) {
                    openCount++;
                    double d = Math.sqrt(p.distSqr(feet));
                    if (d < nearestOpenD) {
                        nearestOpenD = d;
                        nearestOpen = p.immutable();
                    }
                }
            }
            boolean isIce = st.is(Blocks.ICE) || st.is(Blocks.FROSTED_ICE)
                || st.is(Blocks.PACKED_ICE) || st.is(Blocks.BLUE_ICE);
            if (isIce && level.getBlockState(p.below()).is(Blocks.WATER)) {
                iceCount++;
                double d = Math.sqrt(p.distSqr(feet));
                if (d < nearestIceD) {
                    nearestIceD = d;
                    nearestIce = p.immutable();
                }
            }
        }
        sb.append(",\"water\":{\"open_count\":").append(openCount)
            .append(",\"ice_covered_count\":").append(iceCount);
        appendPoint(sb, "nearest_open", nearestOpen, nearestOpenD);
        appendPoint(sb, "nearest_ice", nearestIce, nearestIceD);
        sb.append("}");
    }

    private static void appendPoint(StringBuilder sb, String key, BlockPos p, double distance) {
        sb.append(",\"").append(key).append("\":");
        if (p == null) {
            sb.append("null");
            return;
        }
        sb.append("{\"x\":").append(p.getX()).append(",\"y\":").append(p.getY())
            .append(",\"z\":").append(p.getZ())
            .append(",\"distance\":").append(num(distance)).append("}");
    }

    private static void appendTerrain(StringBuilder sb, ServerLevel level, Entity self) {
        BlockPos feet = self.blockPosition();
        BlockPos head = feet.above();
        BlockState feetState = level.getBlockState(feet);
        BlockState headState = level.getBlockState(head);
        boolean inLava = feetState.is(Blocks.LAVA) || headState.is(Blocks.LAVA);
        sb.append(",\"terrain\":{");
        sb.append("\"in_water\":").append(self.isInWater());
        sb.append(",\"in_lava\":").append(inLava);
        sb.append(",\"on_ground\":").append(self.onGround());
        appendBlock(sb, "feet", level, feet);
        appendBlock(sb, "head", level, head);
        appendBlock(sb, "above", level, head.above());
        appendBlock(sb, "below", level, feet.below());
        sb.append(",\"dirs\":[");
        int[][] dirs = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } };
        int n = 0;
        for (int[] d : dirs) {
            for (int dist = 1; dist <= 2; dist++) {
                BlockPos p = feet.offset(d[0] * dist, 0, d[1] * dist);
                if (n > 0) sb.append(',');
                boolean stand = standable(level, p);
                sb.append("{\"dx\":").append(d[0] * dist).append(",\"dz\":").append(d[1] * dist)
                    .append(",\"standable\":").append(stand)
                    .append(",\"feet\":\"").append(esc(blockId(level, p))).append("\"")
                    .append(",\"head\":\"").append(esc(blockId(level, p.above()))).append("\"}");
                n += 1;
            }
        }
        sb.append("]}");
    }

    private static void appendBlock(StringBuilder sb, String key, ServerLevel level, BlockPos p) {
        BlockState st = level.getBlockState(p);
        boolean solid = !st.getCollisionShape(level, p).isEmpty();
        sb.append(",\"").append(key).append("\":{\"id\":\"").append(esc(blockId(level, p)))
            .append("\",\"solid\":").append(solid)
            .append(",\"liquid\":").append(!st.getFluidState().isEmpty()).append("}");
    }

    private static String blockId(ServerLevel level, BlockPos p) {
        return BuiltInRegistries.BLOCK.getKey(level.getBlockState(p).getBlock()).toString();
    }

    private static boolean standable(ServerLevel level, BlockPos p) {
        BlockState below = level.getBlockState(p.below());
        if (below.getCollisionShape(level, p.below()).isEmpty()) return false;
        BlockState at = level.getBlockState(p);
        BlockState head = level.getBlockState(p.above());
        return at.getCollisionShape(level, p).isEmpty()
            && head.getCollisionShape(level, p.above()).isEmpty()
            && at.getFluidState().isEmpty()
            && head.getFluidState().isEmpty();
    }

    private record Landmark(String kind, BlockPos pos) {}

    private static double num(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "");
    }

    private static void log(String msg) {
        System.out.println("[numen_tree_tentacle] " + msg);
    }
}
