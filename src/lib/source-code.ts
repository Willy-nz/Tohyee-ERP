/**
 * Where Tohyee's source code is. Tohyee is under the GNU AGPL, which asks
 * anyone who runs a changed copy for other people over a network to offer
 * those people its source (section 13). The sign-in page and the account
 * menu link here. If you change Tohyee and run it for others, point this at
 * your own copy of the code.
 */
export const SOURCE_CODE_REPOSITORY = "https://github.com/Willy-nz/Tohyee-ERP";

/** The source of one released version (its tag), or the repository when the version isn't x.y.z. */
export function sourceCodeUrl(version?: string | null): string {
  return version && /^\d+\.\d+\.\d+$/.test(version) ? `${SOURCE_CODE_REPOSITORY}/tree/v${version}` : SOURCE_CODE_REPOSITORY;
}
