import { USABLE_NAME } from '@/lib/name'

/** Two short lists, so a generated name reads as a name and never as a
 *  hash. Every word passes `USABLE_NAME` on its own. */
const ADJECTIVES = [
  'quiet', 'brisk', 'calm', 'bold', 'keen', 'mild', 'swift', 'warm', 'wise',
  'amber', 'coral', 'dusky', 'early', 'fresh', 'gentle', 'hazy', 'lucid',
  'mellow', 'misty', 'noble', 'plain', 'rapid', 'rustic', 'sunny', 'tidy',
  'vivid', 'witty', 'zesty', 'sage', 'still',
]

const ANIMALS = [
  'otter', 'heron', 'finch', 'lynx', 'crane', 'badger', 'beetle', 'bison',
  'cobra', 'dingo', 'egret', 'ferret', 'gecko', 'ibis', 'jackal', 'koala',
  'lemur', 'marten', 'newt', 'osprey', 'panda', 'quail', 'raven', 'stoat',
  'tapir', 'urchin', 'vole', 'wren', 'yak', 'zebra',
]

const pick = (list: readonly string[], random: () => number) =>
  list[Math.min(list.length - 1, Math.floor(random() * list.length))]!

/** `quiet-otter`: the name a session gets when nobody types one. */
export function generateName(random: () => number = Math.random): string {
  const name = `${pick(ADJECTIVES, random)}-${pick(ANIMALS, random)}`
  return USABLE_NAME.test(name) ? name : 'quiet-otter'
}
