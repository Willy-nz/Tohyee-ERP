import { describe, expect, it } from "vitest";
import { parseExtraFunctions } from "@/lib/analytics/databases/extra-functions";
import { checkReadOnlyQuery } from "@/lib/analytics/databases/guard";

/** The check on typed queries for database sources. */
describe("checkReadOnlyQuery", () => {
  it("accepts one SELECT or WITH query and drops a final semicolon", () => {
    expect(checkReadOnlyQuery("select id, total from orders;", "postgres")).toBe("select id, total from orders");
    expect(checkReadOnlyQuery("  SELECT 1  ;;  ", "mysql")).toBe("SELECT 1");
    expect(checkReadOnlyQuery("with recent as (select * from orders where placed > '2026-01-01') select * from recent", "postgres")).toContain("with recent");
    expect(checkReadOnlyQuery("(select 1) union all (select 2)", "postgres")).toBe("(select 1) union all (select 2)");
  });

  it("ignores forbidden words inside strings and quoted names", () => {
    expect(() => checkReadOnlyQuery(`select 'delete me; drop table x' as note, "update" from t`, "postgres")).not.toThrow();
    expect(() => checkReadOnlyQuery("select `insert`, 'it''s set' from t", "mysql")).not.toThrow();
    expect(() => checkReadOnlyQuery("select [delete], [order]]x] from dbo.t", "sqlserver")).not.toThrow();
    expect(() => checkReadOnlyQuery("select $$drop table x$$, $tag$ insert $tag$", "postgres")).not.toThrow();
    // PostgreSQL's E'' strings and MySQL's strings use backslash escapes.
    expect(() => checkReadOnlyQuery(String.raw`select E'it\'s; delete' from t`, "postgres")).not.toThrow();
    expect(() => checkReadOnlyQuery(String.raw`select 'it\'s; delete' from t`, "mysql")).not.toThrow();
  });

  it("removes comments, so what is checked is what runs", () => {
    expect(checkReadOnlyQuery("select 1 -- drop table x\n, 2", "postgres")).toBe("select 1  \n, 2");
    expect(checkReadOnlyQuery("select /* update */ 1", "sqlserver")).toBe("select   1");
    expect(checkReadOnlyQuery("select 1 # delete\n", "mysql")).toBe("select 1");
    // MySQL would run the contents of /*! ... */, so they're dropped, not trusted.
    expect(checkReadOnlyQuery("select 1 /*!50000 , sleep(1) */", "mysql")).toBe("select 1");
    // PostgreSQL's comments nest.
    expect(checkReadOnlyQuery("select /* a /* b */ c */ 1", "postgres")).toBe("select   1");
  });

  it("refuses anything that isn't a single SELECT", () => {
    for (const sql of [
      "delete from orders",
      "update orders set total = 0",
      "insert into orders values (1)",
      "drop table orders",
      "truncate orders",
      "exec sp_who",
      "call refresh()",
      "show tables",
      "values (1)",
      "",
      "   ",
    ]) {
      expect(() => checkReadOnlyQuery(sql, "postgres"), sql).toThrow();
    }
    expect(() => checkReadOnlyQuery("select 1; select 2", "postgres")).toThrow(/one query/);
    expect(() => checkReadOnlyQuery("select 1; delete from t", "mysql")).toThrow(/one query/);
  });

  it("refuses writing words anywhere, including SQL Server batches without semicolons", () => {
    expect(() => checkReadOnlyQuery("select 1 delete from orders", "sqlserver")).toThrow(/DELETE/);
    expect(() => checkReadOnlyQuery("with d as (delete from t returning *) select * from d", "postgres")).toThrow(/DELETE/);
    expect(() => checkReadOnlyQuery("select * into backup_orders from orders", "sqlserver")).toThrow(/INTO/);
    expect(() => checkReadOnlyQuery("select * from orders into outfile '/tmp/x'", "mysql")).toThrow(/INTO/);
    expect(() => checkReadOnlyQuery("select * from orders for update", "postgres")).toThrow(/UPDATE/);
    expect(() => checkReadOnlyQuery("select * from orders for share", "postgres")).toThrow(/lock rows/);
    expect(() => checkReadOnlyQuery("select * from orders lock in share mode", "mysql")).toThrow(/LOCK/);
    expect(() => checkReadOnlyQuery("select 1 waitfor delay '00:00:10'", "sqlserver")).toThrow(/WAITFOR/);
    expect(() => checkReadOnlyQuery("select * from openrowset('SQLNCLI', 'x', 'select 1')", "sqlserver")).toThrow(/OPENROWSET/);
  });

  it("refuses functions that change data, read the server's files or reach other servers", () => {
    expect(() => checkReadOnlyQuery("select nextval('orders_id_seq')", "postgres")).toThrow(/nextval/);
    expect(() => checkReadOnlyQuery("select pg_read_file('/etc/passwd')", "postgres")).toThrow(/pg_read_file/);
    expect(() => checkReadOnlyQuery("select pg_advisory_lock(1)", "postgres")).toThrow(/pg_advisory_lock/);
    expect(() => checkReadOnlyQuery("select * from dblink('host=x', 'select 1') as t(a int)", "postgres")).toThrow(/dblink/);
    expect(() => checkReadOnlyQuery("select lo_import('/etc/passwd')", "postgres")).toThrow(/lo_import/);
    expect(() => checkReadOnlyQuery("select load_file('/etc/passwd')", "mysql")).toThrow(/load_file/);
    expect(() => checkReadOnlyQuery("select PG_TERMINATE_BACKEND (1)", "postgres")).toThrow(/pg_terminate_backend/);
    // The same names as plain columns are fine.
    expect(() => checkReadOnlyQuery("select nextval, lo_value from t", "postgres")).not.toThrow();
  });

  it("refuses functions that run a query held in a string, or just wait", () => {
    for (const sql of [
      "select query_to_xml('select pg_read_file(''/etc/passwd'')', true, true, '')",
      "select * from query_to_xml_and_xmlschema('select 1', true, true, '')",
      "select table_to_xml('pg_authid', true, true, '')",
      "select schema_to_xml('public', true, true, '')",
      "select database_to_xml(true, true, '')",
      "select cursor_to_xml('c', 10, true, true, '')",
      "select pg_catalog.query_to_xml('select 1', true, true, '')",
      "select 1 from orders where pg_sleep(30) is null",
      "select pg_sleep_for('5 minutes')",
      "select pg_sleep_until('tomorrow')",
    ]) {
      expect(() => checkReadOnlyQuery(sql, "postgres"), sql).toThrow("can't call");
    }
    expect(() => checkReadOnlyQuery("select sleep(30)", "mysql")).toThrow("can't call sleep()");
    expect(() => checkReadOnlyQuery("select benchmark(100000000, md5('x'))", "mysql")).toThrow("can't call benchmark()");
    // A column or table with one of these names is fine: only a call is refused.
    expect(() => checkReadOnlyQuery("select sleep, benchmark from habits", "postgres")).not.toThrow();
    expect(() => checkReadOnlyQuery("select 'query_to_xml(1)' as note from t", "postgres")).not.toThrow();
  });

  it("refuses a refused function called by its quoted name", () => {
    expect(() => checkReadOnlyQuery(`select "pg_read_file"('/etc/passwd')`, "postgres")).toThrow("can't call pg_read_file()");
    expect(() => checkReadOnlyQuery(`select pg_catalog."query_to_xml" ('select 1', true, true, '')`, "postgres")).toThrow("can't call query_to_xml()");
    expect(() => checkReadOnlyQuery(`select "PG_SLEEP"(5)`, "postgres")).toThrow("can't call");
    expect(() => checkReadOnlyQuery("select `load_file`('/etc/passwd')", "mysql")).toThrow("can't call load_file()");
    expect(() => checkReadOnlyQuery("select `sleep`(10)", "mysql")).toThrow("can't call sleep()");
    // A name spelt with escapes would hide it, so that spelling is refused outright.
    expect(() => checkReadOnlyQuery(`select U&"pg\\005Fread_file"('/etc/passwd')`, "postgres")).toThrow('U&"..."');
    expect(() => checkReadOnlyQuery(`select u&"d\\0061ta" from t`, "postgres")).toThrow('U&"..."');
    expect(() => checkReadOnlyQuery(`select U&'d\\0061ta' as note, "u&" from t`, "postgres")).not.toThrow();
    // Quoted names that aren't calls, and ordinary quoted functions, still pass.
    expect(() => checkReadOnlyQuery(`select "pg_read_file" from "nextval"`, "postgres")).not.toThrow();
    expect(() => checkReadOnlyQuery(`select "upper"(name), [lo_export] from t`, "sqlserver")).not.toThrow();
    expect(() => checkReadOnlyQuery(`select count("id") from orders where "set" in (1, 2)`, "postgres")).not.toThrow();
  });

  it("refuses unclosed quotes, comments and brackets", () => {
    expect(() => checkReadOnlyQuery("select 'abc", "postgres")).toThrow(/quote/);
    expect(() => checkReadOnlyQuery("select [abc", "sqlserver")).toThrow(/quote/);
    expect(() => checkReadOnlyQuery("select 1 /* open", "mysql")).toThrow(/comment/);
    expect(() => checkReadOnlyQuery("select (1", "postgres")).toThrow(/\)/);
    expect(() => checkReadOnlyQuery("select 1)", "postgres")).toThrow(/\(/);
    expect(() => checkReadOnlyQuery("select $x$ open", "postgres")).toThrow(/quote/);
  });

  it("refuses ORDER BY at the end for SQL Server, which can't wrap it, but not inside", () => {
    expect(() => checkReadOnlyQuery("select * from t order by id", "sqlserver")).toThrow(/ORDER BY/);
    expect(() => checkReadOnlyQuery("select row_number() over (order by id) as n from t", "sqlserver")).not.toThrow();
    expect(() => checkReadOnlyQuery("select * from t order by id", "postgres")).not.toThrow();
  });

  it("limits the length", () => {
    expect(() => checkReadOnlyQuery(`select ${"1, ".repeat(10_000)}1`, "postgres")).toThrow(/20,000/);
  });

  describe("only functions Tohyee knows, or the connection allows", () => {
    const unknown = /doesn't know the function/;

    it("lets everyday queries through on each database", () => {
      const fine: Array<[string, "postgres" | "mysql" | "sqlserver"]> = [
        ["select customer, sum(total) as total, count(*) filter (where paid) from orders group by customer having sum(total) > 0", "postgres"],
        ["select date_trunc('month', placed_at)::date, round(avg(total)::numeric(12, 2), 2), coalesce(max(note), '') from orders group by 1", "postgres"],
        ["with totals(customer, total) as (select customer, sum(total) from orders group by customer) select * from totals where total in (select max(total) from totals)", "postgres"],
        ["select t.a, row_number() over (partition by t.a order by t.b) from (values (1, 2), (1, 3)) as t(a, b)", "postgres"],
        ["select extract(year from placed_at), cast(total as varchar(20)), substring(note from 1 for 10), pg_catalog.lower(note) from orders where exists (select 1) and id = any (array[1, 2])", "postgres"],
        ["select `customer`, ifnull(sum(total), 0), date_format(placed_at, '%Y-%m'), if(total > 0, 'in', 'out') from orders group by 1, 3, 4", "mysql"],
        ["select top (10) customer, isnull(sum(total), 0), datefromparts(year(placed_at), month(placed_at), 1), try_cast(note as nvarchar(50)) from dbo.orders group by customer, placed_at, note", "sqlserver"],
        ["select a.id, x.total from orders a cross apply (select sum(total) as total from lines l where l.order_id = a.id) x", "sqlserver"],
      ];
      for (const [query, engine] of fine) expect(() => checkReadOnlyQuery(query, engine), query).not.toThrow();
    });

    it("refuses a function it doesn't know, however it's written", () => {
      expect(() => checkReadOnlyQuery("select fiscal_year(placed_at) from orders", "postgres")).toThrow(unknown);
      expect(() => checkReadOnlyQuery("select reporting.fiscal_year(placed_at) from orders", "postgres")).toThrow(unknown);
      expect(() => checkReadOnlyQuery('select "Fiscal_Year"(placed_at) from orders', "postgres")).toThrow(unknown);
      expect(() => checkReadOnlyQuery("select dbo.fn_net(total) from orders", "sqlserver")).toThrow(unknown);
      expect(() => checkReadOnlyQuery("select [fn_net](total) from orders", "sqlserver")).toThrow(unknown);
      expect(() => checkReadOnlyQuery("select `net`(total) from orders", "mysql")).toThrow(unknown);
      // Known on one database isn't known on another.
      expect(() => checkReadOnlyQuery("select date_trunc('month', placed_at) from orders", "mysql")).toThrow(unknown);
      // A made-up function can't pass as a CTE or an alias.
      expect(() => checkReadOnlyQuery("with t as (select 1) select mystery(a) as x from t", "postgres")).toThrow(unknown);
      expect(() => checkReadOnlyQuery("select 1, mystery(2)", "postgres")).toThrow(unknown);
    });

    it("lets a connection's extra functions through, but never a refused one", () => {
      expect(() => checkReadOnlyQuery("select reporting.fiscal_year(placed_at) from orders", "postgres", ["fiscal_year"])).not.toThrow();
      expect(() => checkReadOnlyQuery('select "fiscal_year"(placed_at) from orders', "postgres", ["fiscal_year"])).not.toThrow();
      expect(() => checkReadOnlyQuery("select pg_read_file('x')", "postgres", ["pg_read_file"])).toThrow(/can't call pg_read_file/);
      expect(() => checkReadOnlyQuery("select pg_sleep(5)", "postgres", ["pg_sleep"])).toThrow(/can't call pg_sleep/);
    });

    it("reads the Extra functions box", () => {
      expect(parseExtraFunctions("")).toEqual([]);
      expect(parseExtraFunctions(undefined)).toEqual([]);
      expect(parseExtraFunctions("Net_Of_GST, fiscal_year()\nfiscal_year")).toEqual(["fiscal_year", "net_of_gst"]);
      expect(parseExtraFunctions(["b", "a"])).toEqual(["a", "b"]);
      expect(() => parseExtraFunctions("reporting.fiscal_year")).toThrow(/isn't a function name/);
      expect(() => parseExtraFunctions("dblink_exec")).toThrow(/can't be allowed/);
      expect(() => parseExtraFunctions("pg_read_file")).toThrow(/can't be allowed/);
      expect(() => parseExtraFunctions(Array.from({ length: 51 }, (_, index) => `f${index}`))).toThrow(/up to 50/);
      expect(() => parseExtraFunctions(7)).toThrow(/by name/);
    });
  });
});
