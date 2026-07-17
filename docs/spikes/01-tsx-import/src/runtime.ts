export const kitApiVersion = 1

export function Panel(props: { id: string; title: string }): string {
  return `Panel#${props.id}(${props.title})`
}
