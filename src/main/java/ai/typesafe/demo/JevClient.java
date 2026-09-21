package ai.typesafe.demo;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal Jev 1.13 client (TypeSafe SystemOne API).
 *
 * Endpoint, model and deadline are environment-driven so this client stays in
 * sync with the Node implementation (src/jev-client.js):
 *   JEV_BASE_URL   - default https://opencode.ai/zen/v1/systemone
 *   JEV_MODEL      - default jev-1.13-free (zen-free, anonymous)
 *   JEV_TIMEOUT_MS - default 10000 ms
 *   OPENCODE_API_KEY / TYPESAFE_API_KEY - optional; the default endpoint works
 *   anonymously, direct TypeSafe always requires a key.
 *
 * Body: { state, model, questions: { pick: { type:"choice", instructions, criteria } } }
 * Answer: answers.pick.probabilities -> percentages per option.
 */
public class JevClient {

    private static final String DEFAULT_ENDPOINT = "https://opencode.ai/zen/v1/systemone";
    private static final String DEFAULT_MODEL = "jev-1.13-free";
    private static final long DEFAULT_TIMEOUT_MS = 10_000;

    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient http;
    private final String endpoint;
    private final String model;
    private final String apiKey; // null => anonymous (only zen-free allows that)
    private final long timeoutMs;

    /** Uses the default endpoint/model and the given key (null = anonymous). */
    public JevClient(String apiKey) {
        this(DEFAULT_ENDPOINT, DEFAULT_MODEL, apiKey, DEFAULT_TIMEOUT_MS);
    }

    public JevClient(String endpoint, String model, String apiKey, long timeoutMs) {
        this.endpoint = (endpoint == null || endpoint.isBlank()) ? DEFAULT_ENDPOINT : endpoint;
        this.model = (model == null || model.isBlank()) ? DEFAULT_MODEL : model;
        this.timeoutMs = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
        if (apiKey == null || apiKey.isBlank()) {
            // Direct TypeSafe is authenticated-only: fail early with a fixable
            // message instead of sending a request that comes back 401.
            if (this.endpoint.contains("api.typesafe.ai")) {
                throw new IllegalArgumentException("Missing API key for " + this.endpoint
                        + " (set TYPESAFE_API_KEY, get one at https://console.typesafe.ai/keys)");
            }
            this.apiKey = null;
        } else {
            this.apiKey = apiKey;
        }
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(this.timeoutMs)).build();
    }

    /** Endpoint/model/key/deadline from the environment (see class docs). */
    public static JevClient fromEnv() {
        return new JevClient(
                env("JEV_BASE_URL", DEFAULT_ENDPOINT),
                env("JEV_MODEL", DEFAULT_MODEL),
                firstNonBlank(System.getenv("OPENCODE_API_KEY"), System.getenv("TYPESAFE_API_KEY")),
                parsePositiveLong(env("JEV_TIMEOUT_MS", null), DEFAULT_TIMEOUT_MS));
    }

    public record ScoreResult(String choice, Map<String, Double> probabilities, double confidence, String model) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    static class SysOneResponse {
        public String model;
        public Map<String, ChoiceAnswer> answers;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    static class ChoiceAnswer {
        public String type;
        public String choice;
        public Map<String, Double> probabilities;
        public double confidence;
    }

    /**
     * @param state   context to evaluate against (e.g. task description + conversation)
     * @param question Cline question text, e.g. "Which CI/CD platform?"
     * @param options  Cline options, e.g. ["GitHub Actions","GitLab CI","Other"]
     */
    public ScoreResult scoreOptions(String state, String question, List<String> options) throws Exception {
        if (question == null || question.isBlank()) {
            throw new IllegalArgumentException("question must not be blank");
        }
        if (options == null || options.size() < 2) {
            throw new IllegalArgumentException("need at least 2 options to score");
        }

        Map<String, String> criteria = new LinkedHashMap<>();
        for (String opt : options) {
            // key must be a safe id; keep the label as the value so Jev sees it
            criteria.put(slug(opt), opt);
        }

        Map<String, Object> choiceQ = Map.of(
                "type", "choice",
                "instructions", question,
                "criteria", criteria);

        Map<String, Object> body = Map.of(
                "state", (state == null || state.isBlank()) ? question : state,
                "model", model,
                "questions", Map.of("pick", choiceQ));

        HttpRequest.Builder req = HttpRequest.newBuilder()
                .uri(URI.create(endpoint))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofMillis(timeoutMs))
                .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)));
        if (apiKey != null) {
            req.header("Authorization", "Bearer " + apiKey);
        }

        HttpResponse<String> res = http.send(req.build(), HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() / 100 != 2) {
            throw new RuntimeException("Jev " + res.statusCode() + " from " + endpoint + ": " + truncate(res.body()));
        }

        SysOneResponse parsed;
        try {
            parsed = mapper.readValue(res.body(), SysOneResponse.class);
        } catch (Exception e) {
            throw new RuntimeException("Jev returned non-JSON: " + truncate(res.body()), e);
        }
        ChoiceAnswer ans = parsed.answers == null ? null : parsed.answers.get("pick");
        if (ans == null || ans.probabilities == null || ans.probabilities.isEmpty()) {
            throw new RuntimeException("Bad Jev response (no answers.pick.probabilities): " + truncate(res.body()));
        }

        // map slugs back to the original labels
        Map<String, Double> labeled = new LinkedHashMap<>();
        for (String opt : options) {
            labeled.put(opt, ans.probabilities.getOrDefault(slug(opt), 0.0));
        }
        return new ScoreResult(unslug(ans.choice, options), labeled, ans.confidence, parsed.model);
    }

    private static String env(String name, String fallback) {
        String v = System.getenv(name);
        return (v == null || v.isBlank()) ? fallback : v;
    }

    private static String firstNonBlank(String a, String b) {
        if (a != null && !a.isBlank()) return a;
        if (b != null && !b.isBlank()) return b;
        return null;
    }

    private static long parsePositiveLong(String raw, long fallback) {
        if (raw == null) return fallback;
        try {
            long v = Long.parseLong(raw.trim());
            return v > 0 ? v : fallback;
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static String truncate(String s) {
        if (s == null) return "";
        return s.length() <= 300 ? s : s.substring(0, 300) + "...";
    }

    private static String slug(String s) {
        String sl = s.toLowerCase().replaceAll("[^a-z0-9]+", "_").replaceAll("^_|_$", "");
        return sl.isBlank() ? "option" : sl.substring(0, Math.min(sl.length(), 40));
    }

    private static String unslug(String slug, List<String> options) {
        for (String opt : options) {
            if (slug(opt).equals(slug)) return opt;
        }
        return slug;
    }
}
