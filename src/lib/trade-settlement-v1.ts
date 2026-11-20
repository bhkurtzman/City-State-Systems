/**
 * Previous per-ton settlement, kept so the flat-fee payments can be put back.
 * Nothing here runs. Stage 1 replaced it in `src/lib/trade.ts`.
 *
 * An export paid the seller the foreign price minus the post's flat fee, and paid
 * that flat fee to the trader. The sold ledger recorded the seller's bid.
 *
 *   const bid = (WEST_EUROPE[good] as Quote).price - fee
 *   credit(wealth, row.owner, bid)
 *   credit(wealth, post.owner, fee)
 *   noteLedger(good, TON, bid, "sold")
 *   shipments.push({ postId: post.structureId, good, way: "export", dollars: bid })
 *
 * A good could be offered when `foreign.price - fee` was at least $1, and a workshop
 * output also needed that bid to clear 1.2 times its Wholesale Bought input cost.
 * The rank itself was the surplus over the export keep, then the 40/20/10/30 roll.
 * Stage 2 replaced that roll. The eligible goods were sorted by surplus, and
 * `pickExport` gave 40% to the first, 20% to the second, 10% to the third, and
 * 30% to any good still listed. Three misses fell through to the fullest pile.
 *
 *   function pickExport(ranked, rng) {
 *     const roll = rng()
 *     if (roll < 0.4) return ranked[0]
 *     if (roll < 0.6 && ranked.length >= 2) return ranked[1]
 *     if (roll < 0.7 && ranked.length >= 3) return ranked[2]
 *     return ranked[Math.min(ranked.length - 1, Math.floor(rng() * ranked.length))]
 *   }
 *
 * An import was offered at the foreign price plus the same flat fee. The buyer paid
 * that ask, the foreign price left the trader, and the trader kept the fee. The
 * trader's own purchase paid only the foreign price.
 *
 *   offers.push({ structureId: slot.structureId, owner: slot.owner, price: foreign.price + slot.fee, room, fee: slot.fee })
 *
 * The property panel showed that flat fee, bids at foreign minus the fee, and asks
 * at foreign plus the fee.
 */
export {}
