// Implemented by Codex (LLM agent): shared relation palette, measured cards, and equal-length color segments.
import type { Point } from '../literature-routing/router'
import type { Paper } from './model'
export type RelationStyle = {type: string; label: string; color: string}
export const relationStyles = require('./relation-style.json') as RelationStyle[]
export const orderedTypes = (types: string[]) => relationStyles.filter(s => types.includes(s.type)).map(s => s.type)
export const styleFor = (type: string) => relationStyles.find(s => s.type === type)
export const OVERVIEW_VERSION = 2
export function firstAuthor(paper: Paper): string {
  const first = paper.authors?.[0]?.replace(/^\[\[|\]\]$/g, '').split('|').pop()?.split('/').pop() || 'Unknown author'
  return first + (paper.year ? ` · ${paper.year}` : '')
}
export function measurePaper(paper: Paper, width = 380): {width: number; height: number} {
  const card = document.createElement('div')
  card.className = 'literature-paper-card'
  card.style.cssText = `position:fixed;left:-10000px;top:0;visibility:hidden;width:${width - 2}px;`
  const title = document.createElement('div'), author = document.createElement('div')
  title.className = 'literature-paper-title'; title.textContent = paper.title
  author.className = 'literature-paper-author'; author.textContent = firstAuthor(paper)
  card.append(title, author); document.body.appendChild(card)
  const height = Math.ceil(card.getBoundingClientRect().height) + 4
  card.remove()
  return {width, height}
}
export const pathLength = (ps: Point[]) => ps.slice(1).reduce((length, p, i) => length + Math.hypot(p.x - ps[i].x, p.y - ps[i].y), 0)
export function splitPath(points: Point[], count: number): Point[][] {
  if (count < 1 || !Number.isInteger(count)) throw new Error('Color segment count must be positive')
  if (points.length < 2 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return []
  const total = pathLength(points)
  if (total < 1e-8) return []
  const pieces: Point[][] = [], step = total / count
  let travelled = 0, part: Point[] = [{...points[0]}], boundary = step
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length < 1e-8) continue
    while (pieces.length < count - 1 && boundary <= travelled + length + 1e-8) {
      const t = Math.max(0, Math.min(1, (boundary - travelled) / length))
      const cut = {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t}
      part.push(cut); pieces.push(part); part = [{...cut}]; boundary = step * (pieces.length + 1)
    }
    if (Math.hypot(part.at(-1)!.x - b.x, part.at(-1)!.y - b.y) > 1e-8) part.push({...b})
    travelled += length
  }
  pieces.push(part)
  return pieces
}
