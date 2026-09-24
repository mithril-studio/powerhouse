/** The branch a feature ships to once the ship workflow is green. */
export const PRODUCTION_BRANCH = "main";

/** Heading for the Merge tab's commit list. */
export function landedHeading(target: string, base: string | null): string {
  return base ? `On ${target} since ${base}` : `Latest on ${target}`;
}

/** One-line status under the heading. */
export function landedStatus(count: number, fetched: boolean): string {
  const n = count === 1 ? "1 commit" : `${count} commits`;
  return fetched ? n : `${n} · fetch failed, showing last known`;
}
