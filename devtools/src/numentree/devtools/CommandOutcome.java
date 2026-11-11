package numentree.devtools;

import java.util.List;

/** Transport-independent outcome of one GM command attempt. */
public record CommandOutcome(
        boolean ok,
        String world,
        int result,
        List<String> output,
        String errorCode,
        String errorMessage) {

    public CommandOutcome {
        world = world == null ? "" : world;
        output = output == null ? List.of() : List.copyOf(output);
        errorCode = errorCode == null ? "" : errorCode;
        errorMessage = errorMessage == null ? "" : errorMessage;
    }

    public static CommandOutcome ok(String world, int result, List<String> output) {
        return new CommandOutcome(true, world, result, output, "", "");
    }

    public static CommandOutcome error(String world, String code, String message) {
        return new CommandOutcome(false, world, 0, List.of(), code, message);
    }
}
