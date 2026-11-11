package numentree.groundtruth;

/**
 * Executes an already-validated command. Implementations must marshal work to
 * the Minecraft server thread and report the world they actually ran in.
 */
public interface CommandSink {
    CommandOutcome execute(String command) throws Exception;
}
