export const count = (of: number) => of.toLocaleString()

/** `price.rs`'s own rule: under a cent is not nothing, and `$0.00` would say
 *  it was. */
export function money(amount: number): string {
  return amount > 0 && amount < 0.005 ? '<$0.01' : `$${amount.toFixed(2)}`
}
