import type { RoomSummary } from '@/api'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** `3/20 · 2 members · 5 messages`: the budget first, because it is what waits for the owner. */
export const facts = (room: RoomSummary) =>
  `${room.spent}/${room.budget} · ${plural(room.members, 'member')} · ${plural(room.messages, 'message')}`
