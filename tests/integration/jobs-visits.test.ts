import { jobsAndVisits } from "./jobs-visits-suite";

/** Jobs and visits with the PostgreSQL session in UTC (as in CI's container). */
jobsAndVisits("UTC");
