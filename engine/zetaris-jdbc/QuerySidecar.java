import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Base64;
import java.util.Properties;

/**
 * Zetaris JDBC sidecar for querydoc.
 *
 * The local Zetaris platform exposes no MCP endpoint, only the Lightning JDBC driver, so the TypeScript engine adapter
 * (engine/zetaris.ts) talks to Zetaris through this small long-lived process: one warm connection, one request per line.
 *
 * Request (stdin, one line, tab-separated):  id  op  maxRows  drain  timeoutSec  base64(sql)
 *   op      = run | ping
 *   maxRows = rows kept in the response; one extra row is read to detect truncation
 *   drain   = 1 keeps reading (counting, not keeping) past maxRows so rowCount is exact; 0 stops at maxRows + 1
 * Response (stdout, one JSON line):  {"id","ok":true,"columns":[{name,type,jdbcType}],"rows":[[..]],"rowCount","truncated",
 *   "executeMs","fetchMs","elapsedMs"}  or  {"id","ok":false,"error","sqlState","elapsedMs"}
 *
 * Values: DECIMAL as a string (exact), DOUBLE/FLOAT as a JSON number (non-finite as a string), BIGINT beyond 2^53 as a
 * string, NULL as null, everything else as its string form. Read-only by contract: the caller's SQL guard is the gate.
 * Credentials come only from the environment (ZETARIS_JDBC_URL, ZETARIS_USER, ZETARIS_PASSWORD).
 */
public class QuerySidecar {
  private static PrintStream out;
  private static Connection conn;

  public static void main(String[] args) throws Exception {
    // The driver logs to stdout; keep stdout for the protocol only.
    out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
    System.setOut(System.err);
    String driver = System.getenv().getOrDefault("ZETARIS_JDBC_DRIVER_CLASS", "com.zetaris.lightning.jdbc.LightningDriver");
    Class.forName(driver);
    out.println("{\"ready\":true}");

    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    String line;
    while ((line = in.readLine()) != null) {
      if (line.isEmpty()) continue;
      String[] f = line.split("\t", -1);
      if (f.length != 6) {
        out.println("{\"id\":null,\"ok\":false,\"error\":\"bad request: expected 6 tab-separated fields\",\"sqlState\":null,\"elapsedMs\":0}");
        continue;
      }
      String id = f[0];
      String op = f[1];
      int maxRows = Integer.parseInt(f[2]);
      boolean drain = "1".equals(f[3]);
      int timeoutSec = Integer.parseInt(f[4]);
      String sql = new String(Base64.getDecoder().decode(f[5]), StandardCharsets.UTF_8);
      out.println(handle(id, op, maxRows, drain, timeoutSec, sql));
    }
    if (conn != null) conn.close();
  }

  private static Connection connection() throws SQLException {
    if (conn != null && !conn.isClosed()) return conn;
    Properties p = new Properties();
    p.put("user", System.getenv("ZETARIS_USER"));
    p.put("password", System.getenv("ZETARIS_PASSWORD"));
    conn = DriverManager.getConnection(System.getenv("ZETARIS_JDBC_URL"), p);
    return conn;
  }

  private static String handle(String id, String op, int maxRows, boolean drain, int timeoutSec, String sql) {
    long t0 = System.nanoTime();
    try {
      if (op.equals("ping")) {
        connection();
        return "{\"id\":" + str(id) + ",\"ok\":true,\"elapsedMs\":" + ms(t0) + "}";
      }
      if (!op.equals("run")) throw new IllegalArgumentException("unknown op " + op);
      try (Statement s = connection().createStatement()) {
        if (timeoutSec > 0) {
          try { s.setQueryTimeout(timeoutSec); } catch (SQLException ignored) { /* driver may not support it */ }
        }
        boolean hasRs = s.execute(sql);
        long t1 = System.nanoTime();
        if (!hasRs) {
          return "{\"id\":" + str(id) + ",\"ok\":false,\"error\":\"statement returned no result set\",\"sqlState\":null,\"elapsedMs\":" + ms(t0) + "}";
        }
        try (ResultSet r = s.getResultSet()) {
          ResultSetMetaData m = r.getMetaData();
          int n = m.getColumnCount();
          StringBuilder cols = new StringBuilder("[");
          for (int i = 1; i <= n; i++) {
            if (i > 1) cols.append(',');
            cols.append("{\"name\":").append(str(m.getColumnLabel(i)))
                .append(",\"type\":").append(str(m.getColumnTypeName(i)))
                .append(",\"jdbcType\":").append(m.getColumnType(i)).append('}');
          }
          cols.append(']');
          StringBuilder rows = new StringBuilder("[");
          long count = 0;
          boolean truncated = false;
          while (r.next()) {
            if (count < maxRows) {
              if (count > 0) rows.append(',');
              rows.append('[');
              for (int i = 1; i <= n; i++) {
                if (i > 1) rows.append(',');
                rows.append(value(r.getObject(i)));
              }
              rows.append(']');
            } else {
              truncated = true;
              if (!drain) { count++; break; }
            }
            count++;
          }
          rows.append(']');
          long t2 = System.nanoTime();
          return "{\"id\":" + str(id) + ",\"ok\":true,\"columns\":" + cols + ",\"rows\":" + rows
              + ",\"rowCount\":" + count + ",\"rowCountExact\":" + (drain || !truncated)
              + ",\"truncated\":" + truncated
              + ",\"executeMs\":" + round((t1 - t0) / 1e6) + ",\"fetchMs\":" + round((t2 - t1) / 1e6)
              + ",\"elapsedMs\":" + ms(t0) + "}";
        }
      }
    } catch (Throwable e) {
      String state = (e instanceof SQLException) ? ((SQLException) e).getSQLState() : null;
      if (e instanceof SQLException && conn != null) {
        try { if (!conn.isValid(2)) { conn.close(); conn = null; } } catch (SQLException ignored) { conn = null; }
      }
      return "{\"id\":" + str(id) + ",\"ok\":false,\"error\":" + str(String.valueOf(e.getMessage()))
          + ",\"sqlState\":" + (state == null ? "null" : str(state)) + ",\"elapsedMs\":" + ms(t0) + "}";
    }
  }

  private static String value(Object v) {
    if (v == null) return "null";
    if (v instanceof BigDecimal) return str(((BigDecimal) v).toPlainString());
    if (v instanceof Double || v instanceof Float) {
      double d = ((Number) v).doubleValue();
      return Double.isFinite(d) ? Double.toString(d) : str(Double.toString(d));
    }
    if (v instanceof Long) {
      long l = (Long) v;
      return Math.abs(l) <= 9007199254740991L ? Long.toString(l) : str(Long.toString(l));
    }
    if (v instanceof Integer || v instanceof Short || v instanceof Byte) return v.toString();
    if (v instanceof Boolean) return v.toString();
    if (v instanceof byte[]) return str(Base64.getEncoder().encodeToString((byte[]) v));
    return str(v.toString());
  }

  private static String ms(long t0) { return round((System.nanoTime() - t0) / 1e6); }

  private static String round(double x) { return String.valueOf(Math.round(x * 10) / 10.0); }

  private static String str(String s) {
    StringBuilder b = new StringBuilder(s.length() + 2).append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"': b.append("\\\""); break;
        case '\\': b.append("\\\\"); break;
        case '\n': b.append("\\n"); break;
        case '\r': b.append("\\r"); break;
        case '\t': b.append("\\t"); break;
        default:
          if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
      }
    }
    return b.append('"').toString();
  }
}
