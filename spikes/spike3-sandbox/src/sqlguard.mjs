// Rules for SQL that a handler passes to db.query. The handler interface forbids string-built SQL:
// values go in parameters, so the statement text holds no quotes, comments, or second statement.
export class SqlRejected extends Error {
  constructor(m) { super(m); this.name = "SqlRejected"; }
}

const START = /^\s*(select|insert|update|delete|with)\b/i;
const FORBIDDEN_CHARS = /['"\;]|--|\/\*|\$\$/;
// Functions that can change the session, read the server's files, or reach out of the database.
const FORBIDDEN_WORDS = /\b(set_config|current_setting|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|lo_get|dblink\w*|copy|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_advisory_lock|query_to_xml|database_to_xml)\b/i;

export function checkSql(sql, params) {
  if (typeof sql !== "string") throw new SqlRejected("db.query needs a string");
  if (sql.length > 4000) throw new SqlRejected("statement is too long");
  if (FORBIDDEN_CHARS.test(sql)) throw new SqlRejected("quotes, semicolons, and comments are not allowed; pass values as parameters");
  if (!START.test(sql)) throw new SqlRejected("only select, insert, update, and delete statements are allowed");
  if (FORBIDDEN_WORDS.test(sql)) throw new SqlRejected("statement uses a function that handlers cannot call");
  if (!Array.isArray(params) || params.length > 50) throw new SqlRejected("params must be an array of at most 50 values");
  for (const p of params) {
    const t = typeof p;
    if (!(p === null || t === "number" || t === "boolean" || (t === "string" && p.length <= 10000))) {
      throw new SqlRejected("params must be strings, numbers, booleans, or null");
    }
  }
}
