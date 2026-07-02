package api;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON parser — no dependencies, no reflection; runs identically on
 * the JVM and under TeaVM (kept differential-testable). Produces
 * LinkedHashMap / ArrayList / String / Double / Boolean / null.
 */
public final class JsonLite {

    private final String src;
    private int pos;

    private JsonLite(String src) {
        this.src = src;
    }

    public static Object parse(String json) {
        JsonLite p = new JsonLite(json);
        p.ws();
        Object v = p.value();
        p.ws();
        if (p.pos != json.length()) {
            throw new IllegalArgumentException("Trailing content at " + p.pos);
        }
        return v;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String json) {
        Object v = parse(json);
        if (!(v instanceof Map)) {
            throw new IllegalArgumentException("Expected a JSON object");
        }
        return (Map<String, Object>) v;
    }

    private Object value() {
        char c = peek();
        switch (c) {
            case '{': return object();
            case '[': return array();
            case '"': return string();
            case 't': expect("true"); return Boolean.TRUE;
            case 'f': expect("false"); return Boolean.FALSE;
            case 'n': expect("null"); return null;
            default: return number();
        }
    }

    private Map<String, Object> object() {
        Map<String, Object> map = new LinkedHashMap<>();
        consume('{');
        ws();
        if (peek() == '}') {
            pos++;
            return map;
        }
        while (true) {
            ws();
            String key = string();
            ws();
            consume(':');
            ws();
            map.put(key, value());
            ws();
            char c = next();
            if (c == '}') return map;
            if (c != ',') throw err("',' or '}'");
        }
    }

    private List<Object> array() {
        List<Object> list = new ArrayList<>();
        consume('[');
        ws();
        if (peek() == ']') {
            pos++;
            return list;
        }
        while (true) {
            ws();
            list.add(value());
            ws();
            char c = next();
            if (c == ']') return list;
            if (c != ',') throw err("',' or ']'");
        }
    }

    private String string() {
        consume('"');
        StringBuilder sb = new StringBuilder();
        while (true) {
            char c = next();
            if (c == '"') return sb.toString();
            if (c == '\\') {
                char e = next();
                switch (e) {
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case '/': sb.append('/'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'n': sb.append('\n'); break;
                    case 'r': sb.append('\r'); break;
                    case 't': sb.append('\t'); break;
                    case 'u':
                        sb.append((char) Integer.parseInt(src.substring(pos, pos + 4), 16));
                        pos += 4;
                        break;
                    default: throw err("escape");
                }
            } else {
                sb.append(c);
            }
        }
    }

    private Double number() {
        int start = pos;
        while (pos < src.length() && "+-0123456789.eE".indexOf(src.charAt(pos)) >= 0) {
            pos++;
        }
        if (start == pos) throw err("number");
        return Double.valueOf(src.substring(start, pos));
    }

    private void ws() {
        while (pos < src.length() && Character.isWhitespace(src.charAt(pos))) {
            pos++;
        }
    }

    private char peek() {
        if (pos >= src.length()) throw err("value");
        return src.charAt(pos);
    }

    private char next() {
        if (pos >= src.length()) throw err("more input");
        return src.charAt(pos++);
    }

    private void consume(char c) {
        if (next() != c) throw err("'" + c + "'");
    }

    private void expect(String word) {
        if (!src.startsWith(word, pos)) throw err(word);
        pos += word.length();
    }

    private IllegalArgumentException err(String expected) {
        return new IllegalArgumentException("JSON: expected " + expected + " at " + pos);
    }

    // ---- typed accessors for builder code ----

    public static double dbl(Map<String, Object> m, String key, double fallback) {
        Object v = m.get(key);
        return v instanceof Double ? (Double) v : fallback;
    }

    public static boolean bool(Map<String, Object> m, String key, boolean fallback) {
        Object v = m.get(key);
        return v instanceof Boolean ? (Boolean) v : fallback;
    }

    public static String str(Map<String, Object> m, String key, String fallback) {
        Object v = m.get(key);
        return v instanceof String ? (String) v : fallback;
    }

    @SuppressWarnings("unchecked")
    public static List<Map<String, Object>> objList(Map<String, Object> m, String key) {
        Object v = m.get(key);
        if (!(v instanceof List)) return new ArrayList<>();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object o : (List<Object>) v) {
            if (o instanceof Map) out.add((Map<String, Object>) o);
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> obj(Map<String, Object> m, String key) {
        Object v = m.get(key);
        return v instanceof Map ? (Map<String, Object>) v : null;
    }
}
