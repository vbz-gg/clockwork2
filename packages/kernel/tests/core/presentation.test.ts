import { describe, expect, test } from "bun:test"
import { lerp, lerpAngle, NodeSet } from "../../src/presentation/index"

interface Item {
  id: string
  value: number
}

function makeSet() {
  const log: string[] = []
  const set = new NodeSet<Item, { value: number }>({
    id: (item) => item.id,
    create: (item) => {
      log.push(`create ${item.id}`)
      return { value: item.value }
    },
    update: (node, item) => {
      log.push(`update ${item.id}`)
      node.value = item.value
    },
    destroy: (_node, id) => {
      log.push(`destroy ${id}`)
    },
  })
  return { set, log }
}

describe("NodeSet", () => {
  test("creates, updates and destroys to match what it is given", () => {
    const { set, log } = makeSet()
    set.sync([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
    ])
    expect(log).toEqual(["create a", "update a", "create b", "update b"])

    log.length = 0
    set.sync([{ id: "a", value: 9 }])
    expect(log).toEqual(["update a", "destroy b"])
    expect(set.get("a")?.value).toBe(9)
    expect(set.get("b")).toBeUndefined()
    expect(set.size).toBe(1)
  })

  test("an empty frame destroys everything", () => {
    const { set, log } = makeSet()
    set.sync([{ id: "a", value: 1 }])
    log.length = 0
    set.sync([])
    expect(log).toEqual(["destroy a"])
    expect(set.size).toBe(0)
  })

  test("an id that comes back is created again", () => {
    const { set, log } = makeSet()
    set.sync([{ id: "a", value: 1 }])
    set.sync([])
    log.length = 0
    set.sync([{ id: "a", value: 2 }])
    expect(log).toEqual(["create a", "update a"])
  })

  test("clear destroys what is left", () => {
    const { set, log } = makeSet()
    set.sync([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
    ])
    log.length = 0
    set.clear()
    expect(log.sort()).toEqual(["destroy a", "destroy b"])
    expect(set.size).toBe(0)
  })
})

describe("interpolation", () => {
  test("lerp lands on its ends", () => {
    expect(lerp(10, 20, 0)).toBe(10)
    expect(lerp(10, 20, 1)).toBe(20)
    expect(lerp(10, 20, 0.5)).toBe(15)
  })

  test("lerpAngle takes the short way round", () => {
    // From just below +pi to just above -pi is a small step forwards, not
    // almost a whole turn backwards.
    const from = 3.1
    const to = -3.1
    const middle = lerpAngle(from, to, 0.5)
    expect(Math.abs(middle) > 3).toBe(true)
    expect(lerpAngle(0, 1, 0)).toBe(0)
    expect(lerpAngle(0, 1, 1)).toBeCloseTo(1, 12)
  })
})
