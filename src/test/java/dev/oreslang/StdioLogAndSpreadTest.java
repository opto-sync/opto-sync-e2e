package dev.oreslang;

import dev.oreslang.parser.Parser;
import dev.oreslang.types.TypeChecker;
import org.graalvm.polyglot.Context;
import org.graalvm.polyglot.Source;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;

final class StdioLogAndSpreadTest {
    @Test
    void stdoutLogConcatenatesArgumentsAndAppendsOneNewline() throws Exception {
        String output = run("""
                pub routine main(): void {
                  stdio.stdout.log("ORES_TEST|", "PASS", "|", "suite/case", "|", "ok");
                  stdio.stdout.log();
                  return;
                }
                """);

        assertEquals("ORES_TEST|PASS|suite/case|ok\n\n", output);
    }

    @Test
    void stdoutLogSpreadAndLogListHaveIdenticalSequenceSemantics() throws Exception {
        String output = run("""
                pub routine main(): void {
                  val parts = arr["A", 1, "B", true];
                  stdio.stdout.log(...parts);
                  stdio.stdout.logList(parts);
                  stdio.stdout.logList(("X", 2, "Y"));
                  return;
                }
                """);

        assertEquals("A1Btrue\nA1Btrue\nX2Y\n", output);
    }

    @Test
    void stdoutSpreadRequiresAnArrayListOrTuple() {
        IllegalArgumentException failure = assertThrows(
                IllegalArgumentException.class,
                () -> TypeChecker.check(Parser.parse("""
                        pub routine main(): void {
                          stdio.stdout.log(...42);
                          return;
                        }
                        """)));

        assertTrue(failure.getMessage().contains("requires an array/list/tuple value"));
    }

    @Test
    void dynamicSpreadDoesNotWeakenFixedArityCallChecking() {
        IllegalArgumentException failure = assertThrows(
                IllegalArgumentException.class,
                () -> TypeChecker.check(Parser.parse("""
                        fnc pair(int left, int right): void {
                          return;
                        }

                        pub routine main(): void {
                          val values = arr[1, 2];
                          pair(...values);
                          return;
                        }
                        """)));

        assertTrue(failure.getMessage().contains("spread arguments require a variadic callable"));
    }

    @Test
    void spreadSyntaxIsRestrictedToCallArgumentLists() {
        assertThrows(
                IllegalArgumentException.class,
                () -> Parser.parse("""
                        pub routine main(): void {
                          val values = arr[1, 2];
                          val invalid = ...values;
                          return;
                        }
                        """));
    }

    private static String run(String program) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        Source source = Source.newBuilder(OresLanguage.ID, program, "stdio-log-spread.ores")
                .mimeType(OresLanguage.MIME_TYPE)
                .build();
        try (Context context = Context.newBuilder(OresLanguage.ID)
                .allowAllAccess(false)
                .out(output)
                .build()) {
            context.eval(source);
        }
        return output.toString(StandardCharsets.UTF_8);
    }
}
