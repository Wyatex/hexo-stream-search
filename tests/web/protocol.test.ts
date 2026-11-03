/**
 * JSONL 单行协议解析：元数据行判定与容错反序列化
 */
import { describe, expect, it } from 'vitest'
import { isMetaRecord, parseJsonlLine } from '../../src/web/core/protocol'

describe('isMetaRecord', () => {
  it('识别 _type === "meta" 的元数据对象', () => {
    expect(isMetaRecord({ _type: 'meta', total: 2, allIds: ['a/', 'b/'], allM: [2, 1] })).toBe(true)
  })

  it('非元数据对象或原始值返回 false', () => {
    expect(isMetaRecord({ id: 'a/', t: 'A' })).toBe(false)
    expect(isMetaRecord({ _type: 'post' })).toBe(false)
    expect(isMetaRecord(null)).toBe(false)
    expect(isMetaRecord(undefined)).toBe(false)
    expect(isMetaRecord('meta')).toBe(false)
    expect(isMetaRecord(123)).toBe(false)
  })
})

describe('parseJsonlLine', () => {
  it('解析合法的元数据行与文章行（含首尾空白与 CRLF）', () => {
    expect(parseJsonlLine('  {"_type":"meta","total":0,"allIds":[]}\r')).toEqual({
      _type: 'meta',
      total: 0,
      allIds: [],
    })
    expect(parseJsonlLine('{"id":"a/","t":"A","u":"/a/","m":1,"g":[],"k":[],"c":"x"}')).toMatchObject({
      id: 'a/',
      m: 1,
    })
  })

  it('忽略空行、纯空白行与语法残缺的 JSON', () => {
    expect(parseJsonlLine('')).toBeUndefined()
    expect(parseJsonlLine('   \r\t  ')).toBeUndefined()
    expect(parseJsonlLine('{"id":')).toBeUndefined()
    expect(parseJsonlLine('not json at all')).toBeUndefined()
  })

  it('合法但非对象类型的 JSON 字面量返回 undefined', () => {
    expect(parseJsonlLine('null')).toBeUndefined()
    expect(parseJsonlLine('42')).toBeUndefined()
    expect(parseJsonlLine('"hello"')).toBeUndefined()
    expect(parseJsonlLine('true')).toBeUndefined()
  })
})
