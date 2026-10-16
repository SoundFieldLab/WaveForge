// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EngineV3 } from '../../src/engine/EngineV3'
import { createV3UiBridge } from '../bridge'
import { useHSETheme } from '../hse-theme'
import { useV3Params } from '../hooks'
import { HSE_DEV_MODE_KEY } from '../sceneStore'
import ScenesPage from './ScenesPage'

function makePage() {
  const bridge = createV3UiBridge(new EngineV3(48000, 2), 48000)
  const onOpenEffect = vi.fn()
  function Harness() {
    return <ScenesPage bridge={bridge} controller={useV3Params(bridge)} theme={useHSETheme()} onOpenEffect={onOpenEffect} />
  }
  const view = render(<Harness />)
  return { bridge, onOpenEffect, view }
}

describe('HSE 场景与叠加效果', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('命名保存后刷新列表，删除后同步消失', () => {
    const { bridge } = makePage()
    fireEvent.change(screen.getByRole('textbox', { name: '场景名称' }), { target: { value: '夜间自用' } })
    fireEvent.click(screen.getByRole('button', { name: '保存为场景' }))
    const savedScene = screen.getByRole('button', { name: '★ 夜间自用' })
    expect(screen.getByRole('group', { name: '场景列表' }).contains(savedScene)).toBe(true)
    expect(bridge.getScenes().find((scene) => scene.name === '夜间自用')?.builtin).toBe(false)
    const volume = bridge.getParams().loudnessNormalization
    fireEvent.click(savedScene)
    expect(savedScene.getAttribute('aria-pressed')).toBe('true')
    expect(bridge.getParams().sceneId).toBe(bridge.getScenes().find((scene) => scene.name === '夜间自用')?.id)
    expect(bridge.getParams().customized).toBe(false)
    expect(bridge.getParams().loudnessNormalization).toEqual(volume)
    fireEvent.click(screen.getByRole('button', { name: '混响启停' }))
    expect(savedScene.getAttribute('aria-pressed')).toBe('false')
    expect(bridge.getParams().customized).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '删除场景「夜间自用」' }))
    expect(screen.queryByRole('button', { name: '★ 夜间自用' })).toBeNull()
  })

  it('内置场景以普通按钮表达当前选择，应用后更新选中态', () => {
    const { bridge } = makePage()
    const scene = bridge.getScenes().find((candidate) => candidate.builtin && candidate.id !== bridge.getParams().sceneId)!
    const button = screen.getByRole('button', { name: scene.name })
    expect(screen.getByRole('group', { name: '场景列表' }).contains(button)).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button)

    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(bridge.getParams().sceneId).toBe(scene.id)
  })

  it('本地存储失败时保留场景名称并反馈保存错误', () => {
    const { bridge } = makePage()
    const nameInput = screen.getByRole('textbox', { name: '场景名称' }) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '尚未保存的调整' } })
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('存储空间不足', 'QuotaExceededError') })

    fireEvent.click(screen.getByRole('button', { name: '保存为场景' }))

    expect(nameInput.value).toBe('尚未保存的调整')
    expect(screen.queryByRole('button', { name: '★ 尚未保存的调整' })).toBeNull()
    expect(bridge.getScenes().some((scene) => scene.name === '尚未保存的调整')).toBe(false)
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ detail: { message: '场景保存失败，无法写入本地存储。请检查存储空间后重试。', type: 'error' } }))
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ type: 'info' }) }))
  })

  it('本地存储失败时保留被删除场景并反馈删除错误', () => {
    const { bridge } = makePage()
    fireEvent.change(screen.getByRole('textbox', { name: '场景名称' }), { target: { value: '需要保留' } })
    fireEvent.click(screen.getByRole('button', { name: '保存为场景' }))
    const storedScenes = localStorage.getItem('waveforge:v3-my-scenes')
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('存储空间不足', 'QuotaExceededError') })

    fireEvent.click(screen.getByRole('button', { name: '删除场景「需要保留」' }))

    expect(screen.getByRole('button', { name: '★ 需要保留' })).toBeTruthy()
    expect(bridge.getScenes().some((scene) => scene.name === '需要保留')).toBe(true)
    expect(localStorage.getItem('waveforge:v3-my-scenes')).toBe(storedScenes)
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ detail: { message: '场景删除失败，无法写入本地存储。请检查存储空间后重试。', type: 'error' } }))
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ type: 'info' }) }))
  })

  it('启停与配置互相独立，未启用卡片维持正常文字透明度', () => {
    const { bridge, onOpenEffect } = makePage()
    const card = screen.getByRole('article', { name: '混响音效' })
    expect(card.style.opacity).toBe('')
    expect(card.style.boxShadow).toBe('')
    fireEvent.click(screen.getByRole('button', { name: '配置混响' }))
    expect(onOpenEffect).toHaveBeenCalledWith('reverb')
    expect(bridge.getParams().reverb.enabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '混响启停' }))
    expect(bridge.getParams().reverb.enabled).toBe(true)
    expect(screen.getByRole('button', { name: '混响启停' }).getAttribute('aria-pressed')).toBe('true')
    expect(onOpenEffect).toHaveBeenCalledTimes(1)
  })

  it('开发者工具在浅色主题使用可读文字并保留真实入口', () => {
    localStorage.setItem(HSE_DEV_MODE_KEY, '1')
    makePage()
    for (const name of ['编辑当前场景', '导出场景库', '写回发布种子', '导入场景库']) {
      const button = screen.getByRole('button', { name })
      expect(button.className).not.toMatch(/text-white/)
    }
    expect(screen.getByRole('button', { name: '导出场景库' }).style.color).toBe('')
  })
})
