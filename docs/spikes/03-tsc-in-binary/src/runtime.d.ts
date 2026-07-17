declare module "@termcraft/runtime" {
  export const kitApiVersion: number
  export function Panel(props: { id: string; title: string }): string
}
