import java.io.*;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.sql.*;
import java.util.*;

/**
 * Runs Jet SQL through UCanAccess (Jackcess + HSQLDB) against a generated .accdb file.
 * UCanAccess is NOT Microsoft Access. The spike uses it as an independent oracle, and the report says so.
 */
public class Oracle {
    static String esc(String s) { return s.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r"); }

    static String cell(ResultSet rs, int i) throws SQLException {
        Object o = rs.getObject(i);
        if (o == null) return "N";
        if (o instanceof Boolean) return "b:" + ((Boolean) o ? "1" : "0");
        if (o instanceof Timestamp) return "d:" + o.toString().replaceAll("\\.0$", "");
        if (o instanceof java.sql.Date) return "d:" + o + " 00:00:00";
        if (o instanceof BigDecimal) return "n:" + ((BigDecimal) o).toPlainString();
        if (o instanceof Number) return "n:" + o;
        return "s:" + esc(o.toString());
    }

    static void dump(ResultSet rs, Path out) throws Exception {
        ResultSetMetaData md = rs.getMetaData();
        StringBuilder sb = new StringBuilder();
        for (int i = 1; i <= md.getColumnCount(); i++) sb.append(i > 1 ? "\t" : "").append(esc(md.getColumnLabel(i)));
        sb.append("\n");
        while (rs.next()) {
            for (int i = 1; i <= md.getColumnCount(); i++) sb.append(i > 1 ? "\t" : "").append(cell(rs, i));
            sb.append("\n");
        }
        Files.writeString(out, sb.toString(), StandardCharsets.UTF_8);
    }

    public static void main(String[] a) throws Exception {
        Path db = Paths.get(a[0]), schema = Paths.get(a[1]), data = Paths.get(a[2]), queries = Paths.get(a[3]), outDir = Paths.get(a[4]);
        Files.createDirectories(outDir);
        Files.deleteIfExists(db);
        try (Connection c = DriverManager.getConnection("jdbc:ucanaccess://" + db + ";newdatabaseversion=V2010")) {
            c.setAutoCommit(true);
            for (String ddl : Files.readAllLines(schema)) if (!ddl.isBlank()) c.createStatement().execute(ddl);
            Map<String, String[]> types = new HashMap<>();
            String table = null; String[] tys = null; PreparedStatement ps = null;
            for (String line : Files.readAllLines(data, StandardCharsets.UTF_8)) {
                if (line.startsWith("#")) {
                    String[] p = line.substring(1).split("\t");
                    table = p[0]; tys = Arrays.copyOfRange(p, 1, p.length);
                    ps = c.prepareStatement("INSERT INTO " + table + " VALUES (" + String.join(",", Collections.nCopies(tys.length, "?")) + ")");
                    continue;
                }
                String[] v = line.split("\t", -1);
                for (int i = 0; i < tys.length; i++) {
                    if (v[i].equals("\\N")) {
                        int t = switch (tys[i]) { case "L" -> Types.INTEGER; case "F" -> Types.DOUBLE; case "C" -> Types.DECIMAL; case "D" -> Types.TIMESTAMP; case "B" -> Types.BOOLEAN; default -> Types.VARCHAR; };
                        ps.setNull(i + 1, t); continue; }
                    switch (tys[i]) {
                        case "L": ps.setInt(i + 1, Integer.parseInt(v[i])); break;
                        case "F": ps.setDouble(i + 1, Double.parseDouble(v[i])); break;
                        case "C": ps.setBigDecimal(i + 1, new BigDecimal(v[i])); break;
                        case "D": ps.setTimestamp(i + 1, Timestamp.valueOf(v[i])); break;
                        case "B": ps.setBoolean(i + 1, v[i].equals("1")); break;
                        default: ps.setString(i + 1, v[i]);
                    }
                }
                ps.executeUpdate();
            }
            // queries.tsv: id <TAB> kind <TAB> checkTable <TAB> sql
            for (String line : Files.readAllLines(queries, StandardCharsets.UTF_8)) {
                if (line.isBlank()) continue;
                String[] p = line.split("\t", 4);
                String id = p[0], kind = p[1], check = p[2], sql = p[3];
                Path out = outDir.resolve(id + ".tsv");
                try {
                    if (kind.equals("select")) {
                        try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery(sql)) { dump(rs, out); }
                    } else {
                        c.setAutoCommit(false);
                        try (Statement s = c.createStatement()) {
                            s.executeUpdate(sql);
                            try (ResultSet rs = s.executeQuery("SELECT * FROM " + check)) { dump(rs, out); }
                        } finally { c.rollback(); c.setAutoCommit(true); }
                    }
                } catch (Throwable t) {
                    c.setAutoCommit(true);
                    Files.writeString(out, "ERROR\t" + esc(String.valueOf(t.getMessage())) + "\n", StandardCharsets.UTF_8);
                }
            }
        }
    }
}
