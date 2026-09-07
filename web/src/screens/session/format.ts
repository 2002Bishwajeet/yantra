export const count = (of: number) => of.toLocaleString()

/** `price.rs`'s own rule: under a cent is not nothing, and `$0.00` would say
 *  it was. */
export function money(amount: number): string {
  return amount > 0 && amount < 0.005 ? '<$0.01' : `$${amount.toFixed(2)}`
}

/** `~` for the home directory, as the boards and a shell print a path. */
export function home(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+/, '~')
}
