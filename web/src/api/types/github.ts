// Y-342 serves these; written from docs/plans/m14-rust-inventory.md §2 (a, b)
// ahead of the Rust. When that row lands its DTOs in `api.ts` and
// `contract.gen.ts`, delete this file and import from there.

/** `GET /api/github` — is a grant present, and whose. Never the token. */
export type Connection = {
  connected: boolean
  login: string | null
  scopes: string[]
}

/** `GET /api/repos`, swept on the 300 s clock like `attention`. The search box
 *  filters this list in the browser (plan §5.4). */
export type Repo = {
  // `owner/name`, the only spelling that is unique across GitHub.
  full_name: string
  private: boolean
  language: string | null
  // RFC 3339 as GitHub sent it.
  pushed_at: string
  clone_url: string
  default_branch: string
}
