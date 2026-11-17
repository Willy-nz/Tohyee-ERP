type DatabaseEngine = "postgres" | "mysql" | "sqlserver";

/**
 * The functions a typed query may call. Everything
 * here only works out a value from what it's given: no files, no other
 * servers, no settings, no waiting, no query held in text. A function that
 * isn't here is refused unless the connection lists it under Extra
 * functions. The lists are generous on purpose (a missing everyday function
 * is a nuisance) and were written from each database's manual, not checked
 * function by function against a running server.
 */

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** Words that come before a bracket without being a function. */
export const NOT_CALLS = new Set(
  words(`select from where and or not in exists any all some on using join lateral apply as when then else case by having
    union except intersect minus values over filter group distinct like ilike between is escape limit offset fetch top
    with materialized recursive pivot unpivot rollup cube sets zone tablesample bernoulli table only`),
);

/** Type names written with a size: varchar(10), numeric(10, 2). */
const TYPES = words(`varchar nvarchar char nchar character varying text numeric decimal dec number float real double
  int integer bigint smallint tinyint mediumint bit varbit binary varbinary time timetz timestamp timestamptz datetime
  datetime2 datetimeoffset smalldatetime date year interval signed unsigned money`);

const COMMON = words(`
  count sum avg min max stddev stddev_pop stddev_samp variance var_pop var_samp every bool_and bool_or
  row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value
  coalesce nullif greatest least cast convert extract
  abs ceil ceiling floor round trunc truncate sign mod power pow sqrt exp ln log log10 log2 pi degrees radians
  sin cos tan cot asin acos atan atan2 rand random
  length char_length character_length octet_length bit_length lower upper trim ltrim rtrim btrim lpad rpad left right
  substring substr position replace reverse repeat concat concat_ws ascii chr initcap translate overlay space
  now current_date current_time current_timestamp localtime localtimestamp
  grouping row array`);

const POSTGRES = words(`
  array_agg string_agg json_agg jsonb_agg json_object_agg jsonb_object_agg bit_and bit_or bit_xor xmlagg
  percentile_cont percentile_disc mode corr covar_pop covar_samp regr_slope regr_intercept regr_count regr_r2
  regr_avgx regr_avgy regr_sxx regr_sxy regr_syy
  div cbrt width_bucket scale min_scale trim_scale gcd lcm factorial sinh cosh tanh
  strpos split_part regexp_replace regexp_match regexp_matches regexp_split_to_array regexp_split_to_table
  regexp_count regexp_instr regexp_like regexp_substr starts_with string_to_array array_to_string format
  quote_ident quote_literal quote_nullable to_hex md5 sha224 sha256 sha384 sha512 encode decode unaccent
  normalize to_ascii
  date_trunc date_part date_bin age make_date make_time make_timestamp make_timestamptz make_interval
  justify_days justify_hours justify_interval to_char to_date to_timestamp to_number isfinite clock_timestamp
  statement_timestamp transaction_timestamp timeofday timezone
  generate_series generate_subscripts unnest cardinality array_length array_upper array_lower array_ndims
  array_dims array_position array_positions array_append array_prepend array_cat array_remove array_replace
  array_fill
  json_build_object jsonb_build_object json_build_array jsonb_build_array to_json to_jsonb row_to_json
  array_to_json json_array_length jsonb_array_length json_extract_path jsonb_extract_path json_extract_path_text
  jsonb_extract_path_text json_typeof jsonb_typeof json_array_elements jsonb_array_elements
  json_array_elements_text jsonb_array_elements_text json_each jsonb_each json_each_text jsonb_each_text
  json_object_keys jsonb_object_keys jsonb_pretty jsonb_strip_nulls json_strip_nulls jsonb_path_query
  jsonb_path_query_first jsonb_path_query_array jsonb_path_exists jsonb_path_match json_object jsonb_object
  json_populate_record jsonb_populate_record json_to_record jsonb_to_record json_to_recordset jsonb_to_recordset
  lower_inc upper_inc isempty range_merge int4range int8range numrange daterange tsrange tstzrange
  num_nulls num_nonnulls bool text int4 int8 float4 float8 uuid
  gen_random_uuid uuid_generate_v4 to_tsvector to_tsquery plainto_tsquery websearch_to_tsquery ts_rank
  ts_headline similarity word_similarity
  host family masklen netmask network broadcast`);

const MYSQL = words(`
  group_concat json_arrayagg json_objectagg bit_and bit_or bit_xor std
  if ifnull isnull nvl
  crc32 conv bin hex unhex oct format
  char instr locate lcase ucase mid insert elt field find_in_set substring_index strcmp quote soundex
  regexp_like regexp_replace regexp_instr regexp_substr to_base64 from_base64 md5 sha sha1 sha2 uuid
  curdate curtime sysdate utc_date utc_time utc_timestamp date time year quarter month week weekday weekofyear
  yearweek day dayofmonth dayofweek dayofyear dayname monthname hour minute second microsecond last_day
  date_add date_sub adddate subdate addtime subtime datediff timediff timestampdiff timestampadd date_format
  time_format str_to_date makedate maketime from_days to_days from_unixtime unix_timestamp period_add
  period_diff sec_to_time time_to_sec convert_tz timestamp
  json_extract json_unquote json_value json_object json_array json_contains json_contains_path json_keys
  json_length json_type json_valid json_search json_quote json_pretty json_depth json_overlaps json_table
  database schema inet_aton inet_ntoa`);

const SQLSERVER = words(`
  string_agg count_big stdev stdevp var varp checksum_agg approx_count_distinct percentile_cont percentile_disc
  isnull iif choose try_cast try_convert try_parse parse
  square
  len datalength charindex patindex stuff replicate str quotename unicode nchar string_split string_escape
  format concat_ws translate soundex difference
  getdate getutcdate sysdatetime sysutcdatetime sysdatetimeoffset dateadd datediff datediff_big datepart
  datename datetrunc year month day eomonth datefromparts datetimefromparts datetime2fromparts timefromparts
  smalldatetimefromparts datetimeoffsetfromparts isdate switchoffset todatetimeoffset
  isnumeric newid hashbytes
  json_value json_query json_modify isjson openjson json_object json_array
  generate_series`);

const KNOWN: Record<DatabaseEngine, Set<string>> = {
  postgres: new Set([...TYPES, ...COMMON, ...POSTGRES]),
  mysql: new Set([...TYPES, ...COMMON, ...MYSQL]),
  sqlserver: new Set([...TYPES, ...COMMON, ...SQLSERVER]),
};

export function knownFunction(engine: DatabaseEngine, name: string): boolean {
  return KNOWN[engine].has(name);
}

/** Most extra functions one connection can list. */
export const MAX_EXTRA_FUNCTIONS = 50;
