import { add, cmp, dec, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/*
 * The MetService forecast's rules (examples WX1-WX10, not yet reviewed). Pure and browser-safe, so the setup, the forecast card
 * and the server agree. Tested in tests/unit/weather-forecast-rules.test.ts.
 *
 * - Each farm has one point (a pin). A refresh asks for the next 7 days,
 *   hour by hour, at each point: one request a farm.
 * - MetService counts API units as requests x variables x points, so one
 *   refresh costs (farms x variables) units and a day costs that times the
 *   refreshes in a day. Frost risk is worked out from the temperature, so
 *   it costs nothing extra.
 * - Values are kept as decimal strings: rain in mm to one place,
 *   temperature in degrees C to one place, wind and gusts in km/h, whole.
 * - The warnings are worked out from the forecast numbers. They aren't
 *   MetService's official warnings, and say so.
 * - Only the latest forecast is kept (a cache), unless the organisation has
 *   enabled records with an acknowledgement of responsibility for its use.
 */

/** The words MetService's terms ask for beside its data (terms 1.3(e) and 2.8). */
export const METSERVICE_ATTRIBUTION = "This data was provided by MetService Limited.";

/** What the forecast numbers are, said beside the warnings, so they aren't taken for official ones. */
export const WARNINGS_NOTE = "Worked out by Tohyee from the forecast numbers. These aren't MetService's official warnings.";

export type WeatherChoice = "rain" | "temperature" | "wind" | "gusts" | "cloud";

export const WEATHER_CHOICES: Array<{ key: WeatherChoice; label: string; note: string; variables: string[] }> = [
  { key: "rain", label: "Rain", note: "mm an hour, and the day's total.", variables: ["precipitation.rate"] },
  { key: "temperature", label: "Temperature", note: "Also gives the frost risk, at no extra cost.", variables: ["air.temperature.at-2m"] },
  { key: "wind", label: "Wind", note: "Speed and direction (2 variables).", variables: ["wind.speed.at-10m", "wind.direction.at-10m"] },
  { key: "gusts", label: "Gusts", note: "The strongest gust each hour.", variables: ["wind.speed.gust.at-10m"] },
  { key: "cloud", label: "Cloud", note: "How much of the sky is covered, for the sun and cloud pictures.", variables: ["cloud.cover"] },
];

export const DEFAULT_CHOICES: WeatherChoice[] = ["rain", "temperature", "wind"];

/** How often the forecast is fetched, in hours. Every 3 hours is the default. */
export const REFRESH_CHOICES = [1, 3, 6, 12] as const;
export type RefreshHours = (typeof REFRESH_CHOICES)[number];
export const DEFAULT_REFRESH_HOURS: RefreshHours = 3;

/** How far ahead a refresh asks for: 7 days, hour by hour. */
export const FORECAST_HOURS = 168;

/** A forecast older than this is deleted, even if refreshing has stopped. */
export const CACHE_MAX_HOURS = 24;

/** A manual refresh at most this often, per organisation. */
export const MANUAL_REFRESH_MINUTES = 15;

export function isWeatherChoice(value: unknown): value is WeatherChoice {
  return typeof value === "string" && WEATHER_CHOICES.some((choice) => choice.key === value);
}

export function isRefreshHours(value: unknown): value is RefreshHours {
  return typeof value === "number" && (REFRESH_CHOICES as readonly number[]).includes(value);
}

/** The MetService variable names for the choices, in a fixed order. */
export function variablesFor(choices: readonly WeatherChoice[]): string[] {
  return WEATHER_CHOICES.filter((choice) => choices.includes(choice.key)).flatMap((choice) => choice.variables);
}

export type UnitsEstimate = { perRefresh: number; refreshesPerDay: number; perDay: number; per30Days: number; variables: number; points: number };

/** API units a refresh, a day and 30 days take: requests x variables x points, one request (one point) a farm. */
export function estimateUnits(input: { choices: readonly WeatherChoice[]; farms: number; refreshHours: number }): UnitsEstimate {
  const variables = variablesFor(input.choices).length;
  const points = Math.max(0, Math.floor(input.farms));
  const perRefresh = variables * points;
  const refreshesPerDay = Math.ceil(24 / Math.max(1, input.refreshHours));
  const perDay = perRefresh * refreshesPerDay;
  return { perRefresh, refreshesPerDay, perDay, per30Days: perDay * 30, variables, points };
}

/** The body of one request for a point: the next 7 days, hourly, from the hour now is in. */
export function forecastRequest(point: { latitude: string; longitude: string }, choices: readonly WeatherChoice[], now: Date) {
  const from = new Date(now);
  from.setUTCMinutes(0, 0, 0);
  return {
    points: [{ lon: Number(point.longitude), lat: Number(point.latitude) }],
    variables: variablesFor(choices),
    time: { from: from.toISOString().replace(".000Z", "Z"), interval: "1h", repeat: FORECAST_HOURS - 1 },
  };
}

/** One hour of the forecast, in the units Tohyee shows. A value MetService had no data for is null. */
export type ForecastHour = {
  at: string;
  rainMm: string | null;
  temperatureC: string | null;
  windKmh: string | null;
  windDirection: string | null;
  gustKmh: string | null;
  /** How much of the sky is covered, 0 to 100. Only there when cloud was fetched (WX13). */
  cloudPct?: string | null;
};

type VariableBlock = { units?: unknown; data?: unknown; noData?: unknown; dimensions?: unknown };

export class ForecastFormatError extends Error {}

function numberAt(block: VariableBlock | undefined, index: number): number | null {
  if (!block || !Array.isArray(block.data)) return null;
  const noData = Array.isArray(block.noData) ? block.noData[index] : 0;
  if (typeof noData === "number" && noData !== 0) return null;
  const value = block.data[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unitsOf(block: VariableBlock | undefined): string {
  return typeof block?.units === "string" ? block.units.toLowerCase() : "";
}

function fixed(value: number | null, places: number): string | null {
  if (value === null) return null;
  const text = value.toFixed(places);
  return text === "-0" || text === "-0.0" ? (places ? `0.${"0".repeat(places)}` : "0") : text;
}

function toCelsius(value: number | null, units: string): number | null {
  if (value === null) return null;
  return units.startsWith("k") ? value - 273.15 : units.includes("f") && !units.includes("c") ? ((value - 32) * 5) / 9 : value;
}

function toKmh(value: number | null, units: string): number | null {
  if (value === null) return null;
  if (units.includes("km")) return value;
  if (units.includes("knot") || units === "kt" || units === "kn") return value * 1.852;
  return value * 3.6;
}

/** Cloud cover as a percentage, whether it came as 0 to 100 or as a fraction of 1. */
function toPercent(value: number | null, units: string): number | null {
  if (value === null) return null;
  const percent = units.includes("%") || units.includes("percent") ? value : units === "1" || units.includes("fraction") ? value * 100 : value;
  return Math.min(100, Math.max(0, percent));
}

function toMmPerHour(value: number | null, units: string): number | null {
  if (value === null) return null;
  if (units.includes("/s") || units.includes("s-1") || units.includes("per second")) return value * 3600;
  return value;
}

/**
 * MetService's answer for one point, as hours (WX3). The answer lists the
 * times, then each variable's values in the same order, with a noData flag
 * for each (0 is good). With one point, the values are one a time.
 */
export function parseForecast(body: unknown): ForecastHour[] {
  if (!body || typeof body !== "object") throw new ForecastFormatError("The forecast came back in a shape Tohyee doesn't know.");
  const root = body as { dimensions?: { time?: { data?: unknown }; point?: { data?: unknown } }; variables?: Record<string, VariableBlock> };
  const times = root.dimensions?.time?.data;
  if (!Array.isArray(times) || times.some((time) => typeof time !== "string") || !root.variables || typeof root.variables !== "object") {
    throw new ForecastFormatError("The forecast came back in a shape Tohyee doesn't know.");
  }
  const points = Array.isArray(root.dimensions?.point?.data) ? (root.dimensions!.point!.data as unknown[]).length || 1 : 1;
  const variables = root.variables;
  const rain = variables["precipitation.rate"];
  const temperature = variables["air.temperature.at-2m"];
  const wind = variables["wind.speed.at-10m"];
  const direction = variables["wind.direction.at-10m"];
  const gust = variables["wind.speed.gust.at-10m"];
  const cloud = variables["cloud.cover"];
  // The first point's values: with time first, a time's values are `points` apart.
  const indexFor = (block: VariableBlock | undefined, timeIndex: number) => {
    const dims = Array.isArray(block?.dimensions) ? (block!.dimensions as unknown[]) : ["time", "point"];
    return dims[0] === "point" ? timeIndex : timeIndex * points;
  };
  return (times as string[]).map((at, timeIndex) => ({
    at,
    rainMm: fixed(clampRain(toMmPerHour(numberAt(rain, indexFor(rain, timeIndex)), unitsOf(rain))), 1),
    temperatureC: fixed(toCelsius(numberAt(temperature, indexFor(temperature, timeIndex)), unitsOf(temperature)), 1),
    windKmh: fixed(toKmh(numberAt(wind, indexFor(wind, timeIndex)), unitsOf(wind)), 0),
    windDirection: fixed(numberAt(direction, indexFor(direction, timeIndex)), 0),
    gustKmh: fixed(toKmh(numberAt(gust, indexFor(gust, timeIndex)), unitsOf(gust)), 0),
    ...(cloud ? { cloudPct: fixed(toPercent(numberAt(cloud, indexFor(cloud, timeIndex)), unitsOf(cloud)), 0) } : {}),
  }));
}

/** A rate a hair below zero is no rain. */
function clampRain(value: number | null): number | null {
  return value === null ? null : Math.max(0, value);
}

/** Leaves out the values for things that weren't chosen, so nothing is kept that wasn't asked for. */
export function onlyChosen(hours: ForecastHour[], choices: readonly WeatherChoice[]): ForecastHour[] {
  return hours.map((hour) => ({
    at: hour.at,
    rainMm: choices.includes("rain") ? hour.rainMm : null,
    temperatureC: choices.includes("temperature") ? hour.temperatureC : null,
    windKmh: choices.includes("wind") ? hour.windKmh : null,
    windDirection: choices.includes("wind") ? hour.windDirection : null,
    gustKmh: choices.includes("gusts") ? hour.gustKmh : null,
    ...(choices.includes("cloud") ? { cloudPct: hour.cloudPct ?? null } : {}),
  }));
}

// Days and warnings ---------------------------------------------------------------------------------

/** The date (YYYY-MM-DD) and hour (0-23) a moment falls on in a time zone. */
export function localParts(at: string, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

export type ForecastDay = {
  date: string;
  hours: number;
  rainMm: string | null;
  minC: string | null;
  maxC: string | null;
  maxWindKmh: string | null;
  maxGustKmh: string | null;
  /** The average cloud cover through the daytime (7 am to 7 pm), 0 to 100. Only there when cloud was fetched. */
  cloudPct?: string | null;
};

/** Daytime, for how sunny a day is: 7 am up to 7 pm. */
const DAY_FROM_HOUR = 7;
const DAY_TO_HOUR = 19;

/** The day's cloud: the average over its daytime hours. With none left today, there's no sky to picture. */
function dayCloud(list: ForecastHour[], timeZone: string): string | null {
  const used = list.filter((hour) => {
    if (typeof hour.cloudPct !== "string") return false;
    const { hour: at } = localParts(hour.at, timeZone);
    return at >= DAY_FROM_HOUR && at < DAY_TO_HOUR;
  });
  if (!used.length) return null;
  return String(Math.round(used.reduce((sum, hour) => sum + Number(hour.cloudPct), 0) / used.length));
}

function maxOf(values: Array<string | null>): string | null {
  return values.reduce<string | null>((best, value) => (value === null ? best : best === null || cmp(dec(value), dec(best)) > 0 ? value : best), null);
}

function minOf(values: Array<string | null>): string | null {
  return values.reduce<string | null>((best, value) => (value === null ? best : best === null || cmp(dec(value), dec(best)) < 0 ? value : best), null);
}

function total(values: Array<string | null>): string | null {
  const known = values.filter((value): value is string => value !== null);
  if (!known.length) return null;
  return toFixedString(known.reduce((sum, value) => add(sum, dec(value)), ZERO_DECIMAL), 1);
}

/** The forecast by local day (WX4): the day's rain, lowest and highest temperature, and strongest wind and gust. */
export function forecastDays(hours: ForecastHour[], timeZone: string): ForecastDay[] {
  const byDay = new Map<string, ForecastHour[]>();
  for (const hour of hours) {
    const { date } = localParts(hour.at, timeZone);
    byDay.set(date, [...(byDay.get(date) ?? []), hour]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({
      date,
      hours: list.length,
      rainMm: total(list.map((hour) => hour.rainMm)),
      minC: minOf(list.map((hour) => hour.temperatureC)),
      maxC: maxOf(list.map((hour) => hour.temperatureC)),
      maxWindKmh: maxOf(list.map((hour) => hour.windKmh)),
      maxGustKmh: maxOf(list.map((hour) => hour.gustKmh)),
      ...(list.some((hour) => hour.cloudPct !== undefined) ? { cloudPct: dayCloud(list, timeZone) } : {}),
    }));
}

/** Frost risk at or below this air temperature (2 degrees: ground frost is likely before the air reaches 0). */
export const FROST_AT_C = "2.0";
/** Heavy rain: this much in a local day, or HEAVY_HOUR_MM in an hour. */
export const HEAVY_DAY_MM = "25.0";
export const HEAVY_HOUR_MM = "10.0";

export type ForecastWarning = { kind: "frost" | "heavy_rain"; date: string; text: string };

/** Frost and heavy rain from the forecast values (WX5), one a kind a day. */
export function forecastWarnings(hours: ForecastHour[], timeZone: string): ForecastWarning[] {
  const warnings: ForecastWarning[] = [];
  for (const day of forecastDays(hours, timeZone)) {
    const list = hours.filter((hour) => localParts(hour.at, timeZone).date === day.date);
    if (day.minC !== null && cmp(dec(day.minC), dec(FROST_AT_C)) <= 0) {
      warnings.push({ kind: "frost", date: day.date, text: `Frost risk: down to ${day.minC} °C.` });
    }
    const wettestHour = maxOf(list.map((hour) => hour.rainMm));
    const heavyDay = day.rainMm !== null && cmp(dec(day.rainMm), dec(HEAVY_DAY_MM)) >= 0;
    const heavyHour = wettestHour !== null && cmp(dec(wettestHour), dec(HEAVY_HOUR_MM)) >= 0;
    if (heavyDay || heavyHour) {
      warnings.push({ kind: "heavy_rain", date: day.date, text: heavyDay ? `Heavy rain: ${day.rainMm} mm in the day.` : `Heavy rain: up to ${wettestHour} mm in an hour.` });
    }
  }
  return warnings;
}

/** A day is windy once its strongest wind reaches this (the start of a strong breeze), unless the farm has its own figure. */
export const WINDY_AT_KMH = 40;
export const WINDY_MIN_KMH = 10;
export const WINDY_MAX_KMH = 150;
/** A day's rain picture shows from this much rain. */
export const RAIN_PICTURE_MM = "1.0";

/** Gusts count as windy at half as much again as the steady wind: 60 km/h for a farm on 40. */
export function gustyAt(windyKmh: number): number {
  return Math.round(windyKmh * 1.5);
}

/** A day is sunny up to this much cloud through the daytime, and cloudy from CLOUDY_FROM_PCT; between is some cloud. */
export const SUNNY_TO_PCT = 25;
export const CLOUDY_FROM_PCT = 75;

/** "part" is some cloud: drawn as the sun and the cloud together. */
export type DayPicture = { kind: "sun" | "part" | "cloud" | "frost" | "rain" | "wind"; label: string };

/**
 * The pictures beside a day (WX12), each with its word: frost at FROST_AT_C
 * or below, rain from RAIN_PICTURE_MM in the day, and wind once the day's
 * strongest wind reaches the farm's figure or its strongest gust reaches
 * half as much again. With cloud fetched (WX13), a day with no rain picture
 * leads with the sky: Sunny up to SUNNY_TO_PCT of cloud through the daytime,
 * Cloudy from CLOUDY_FROM_PCT, and Some cloud between.
 */
export function dayPictures(day: ForecastDay, windyKmh: number = WINDY_AT_KMH): DayPicture[] {
  const pictures: DayPicture[] = [];
  const rainy = day.rainMm !== null && cmp(dec(day.rainMm), dec(RAIN_PICTURE_MM)) >= 0;
  if (!rainy && typeof day.cloudPct === "string") {
    const cloud = Number(day.cloudPct);
    pictures.push(cloud <= SUNNY_TO_PCT ? { kind: "sun", label: "Sunny" } : cloud >= CLOUDY_FROM_PCT ? { kind: "cloud", label: "Cloudy" } : { kind: "part", label: "Some cloud" });
  }
  if (day.minC !== null && cmp(dec(day.minC), dec(FROST_AT_C)) <= 0) pictures.push({ kind: "frost", label: "Frost" });
  if (rainy) pictures.push({ kind: "rain", label: "Rain" });
  const windy = day.maxWindKmh !== null && cmp(dec(day.maxWindKmh), dec(String(windyKmh))) >= 0;
  const gusty = day.maxGustKmh !== null && cmp(dec(day.maxGustKmh), dec(String(gustyAt(windyKmh)))) >= 0;
  if (windy || gusty) pictures.push({ kind: "wind", label: "Windy" });
  return pictures;
}

/** The hours from now on, at most `count` (the next 48 hours on the card). */
export function hoursAhead(hours: ForecastHour[], now: Date, count = 48): ForecastHour[] {
  const start = now.getTime() - 60 * 60 * 1000;
  return hours.filter((hour) => Date.parse(hour.at) > start).slice(0, count);
}

export type Freshness = "fresh" | "stale";

/** A forecast is stale once it's an hour past its next refresh (WX6). */
export function freshness(fetchedAt: string, refreshHours: number, now: Date): Freshness {
  return now.getTime() - Date.parse(fetchedAt) > (refreshHours + 1) * 60 * 60 * 1000 ? "stale" : "fresh";
}

/** Whether a kept forecast is past the most it's kept for, and goes. */
export function pastCacheLimit(fetchedAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(fetchedAt) >= CACHE_MAX_HOURS * 60 * 60 * 1000;
}

/** "5 minutes ago", "3 hours ago", "2 days ago". */
export function ageText(fetchedAt: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(fetchedAt)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/** The compass point a wind comes from, from its direction in degrees. */
export function compassPoint(degrees: string | null): string | null {
  if (degrees === null) return null;
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const value = ((Number(degrees) % 360) + 360) % 360;
  return points[Math.round(value / 45) % 8];
}

// Problems MetService reports ----------------------------------------------------------------------

export type WeatherStatus = "not_tested" | "ok" | "bad_key" | "no_units" | "not_allowed" | "rate_limited" | "error";

export const STATUS_TEXT: Record<WeatherStatus, string> = {
  not_tested: "Not tested yet.",
  ok: "Connected.",
  bad_key: "MetService didn't accept the key. Check it was copied in full, or make a new one in MetService's console and paste it again.",
  no_units: "Your MetService account has no API units left. Refreshing has stopped so nothing more is charged. Add units or raise your limit in MetService's console, then test the connection again.",
  not_allowed: "MetService says this key isn't allowed to use the Point Forecast API. Check the key's access in MetService's console.",
  rate_limited: "MetService asked Tohyee to slow down. It tries again at the next refresh.",
  error: "MetService couldn't be reached, or answered with an error. It tries again at the next refresh.",
};

/**
 * What an HTTP answer from MetService means (WX7). 401 is a bad or expired
 * key (from MetService's docs). Which answer means "no units left" isn't in
 * the docs: 402, and 403 or 429 whose message mentions units, quota, limit
 * or credit, are taken to mean it (not yet tried against the live service).
 */
export function classifyAnswer(status: number, message: string): WeatherStatus {
  if (status >= 200 && status < 300) return "ok";
  const text = message.toLowerCase();
  const aboutUnits = /unit|quota|credit|limit|exhaust|balance|insufficient/.test(text);
  if (status === 401) return "bad_key";
  if (status === 402) return "no_units";
  if (status === 403) return aboutUnits ? "no_units" : "not_allowed";
  if (status === 429) return aboutUnits && !/rate/.test(text) ? "no_units" : "rate_limited";
  return "error";
}

/** Problems that stop refreshing until someone tests the connection again (the spending guard, WX7). */
export function stopsRefreshing(status: WeatherStatus): boolean {
  return status === "no_units" || status === "bad_key" || status === "not_allowed";
}

// Forecast and rain gauge (only with both permissions) -----------------------------------------------

/**
 * The rain day's forecast total (WX9): the rain from 9 am on that day to
 * 9 am the next, as a gauge read at 9 am records it, from one forecast.
 * Null when the forecast doesn't cover all 24 hours or has a gap.
 */
export function rainDayForecast(hours: ForecastHour[], rainDay: string, timeZone: string): string | null {
  const next = new Date(Date.parse(`${rainDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const inDay = hours.filter((hour) => {
    const { date, hour: h } = localParts(hour.at, timeZone);
    return (date === rainDay && h >= 9) || (date === next && h < 9);
  });
  if (inDay.length < 24 || inDay.some((hour) => hour.rainMm === null)) return null;
  return total(inDay.map((hour) => hour.rainMm));
}

/** The gauge reading less the forecast, to one place ("+3.5", "-1.0"). */
export function rainDifference(gaugeMm: string, forecastMm: string): string {
  const difference = sub(dec(gaugeMm), dec(forecastMm));
  const text = toFixedString(difference, 1);
  return text.startsWith("-") ? text : `+${text}`;
}
