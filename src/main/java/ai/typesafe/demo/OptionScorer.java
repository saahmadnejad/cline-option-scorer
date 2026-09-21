package ai.typesafe.demo;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * Demo entry point: takes a Cline ask_followup_question and prints percentages.
 *
 * Run:
 *   TYPESAFE_API_KEY=xxx mvn -q exec:java  (or: mvn package && java -jar ...)
 *   TYPESAFE_API_KEY=xxx java -cp target/cline-option-scorer-0.1.0.jar ai.typesafe.demo.OptionScorer
 */
public class OptionScorer {

    public static void main(String[] args) throws Exception {
        // Example mirroring Cline: <ask_followup_question><question>..</question><options>..</options>
        String state = args.length > 0 ? args[0]
                : "User is setting up CI/CD for a Java Maven project hosted on GitHub.";
        String question = args.length > 1 ? args[1]
                : "Which CI/CD platform should we integrate?";
        List<String> options = args.length > 2
                ? Arrays.asList(Arrays.copyOfRange(args, 2, args.length))
                : List.of("GitHub Actions", "GitLab CI", "Jenkins");

        String apiKey = System.getenv("TYPESAFE_API_KEY");
        JevClient.ScoreResult result;
        try {
            JevClient client = new JevClient(apiKey);
            result = client.scoreOptions(state, question, options);
        } catch (IllegalArgumentException e) {
            System.out.println("[mock - no TYPESAFE_API_KEY] " + e.getMessage());
            mockPrint(question, options);
            return;
        }

        System.out.println("\nQ: " + question);
        System.out.println("Jev choice: " + result.choice()
                + String.format(" (confidence %.0f%%)%n", result.confidence() * 100));
        for (Map.Entry<String, Double> e : result.probabilities().entrySet()) {
            System.out.printf("  %-20s %5.1f%%%n", e.getKey(), e.getValue() * 100);
        }
    }

    private static void mockPrint(String question, List<String> options) {
        System.out.println("\nQ: " + question);
        double each = 1.0 / options.size();
        for (String opt : options) {
            System.out.printf("  %-20s %5.1f%% (mock)%n", opt, each * 100);
        }
        System.out.println("\nSet TYPESAFE_API_KEY to get real Jev 1.13 percentages.");
    }
}
