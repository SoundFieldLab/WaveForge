/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useHazardMapNavigation } from '../src/components/HazardMapPrimitives'

function NavigationHarness() {
  const navigation = useHazardMapNavigation({ minLongitude: 110, maxLongitude: 130, minLatitude: 20, maxLatitude: 40 })
  if (!navigation) return null
  return <div
    ref={navigation.containerRef}
    data-testid="map"
    data-wheel-enabled={String(navigation.wheelZoomEnabled)}
    data-zoom={String(navigation.viewport.zoom)}
    onPointerDown={navigation.onPointerDown}
    onPointerMove={navigation.onPointerMove}
    onPointerUp={navigation.onPointerUp}
    onPointerCancel={navigation.onPointerCancel}
    onPointerLeave={navigation.onPointerLeave}
    onLostPointerCapture={navigation.onLostPointerCapture}
  />
}

const prepareMap = () => {
  const result = render(<NavigationHarness />)
  const map = screen.getByTestId('map')
  Object.defineProperty(map, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, right: 960, bottom: 500, width: 960, height: 500, x: 0, y: 0, toJSON: () => ({}) }),
  })
  Object.defineProperty(map, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(map, 'releasePointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(map, 'hasPointerCapture', { configurable: true, value: vi.fn(() => true) })
  return { ...result, map }
}

afterEach(cleanup)

describe('hazard map wheel activation', () => {
  it('lets the page handle wheel until the map is clicked', () => {
    const { map } = prepareMap()
    const initialZoom = map.getAttribute('data-zoom')
    fireEvent.wheel(map, { deltaY: -100, clientX: 400, clientY: 200 })
    expect(map.getAttribute('data-zoom')).toBe(initialZoom)
    expect(map.getAttribute('data-wheel-enabled')).toBe('false')

    fireEvent.pointerDown(map, { pointerId: 1, button: 0, clientX: 400, clientY: 200 })
    fireEvent.pointerUp(map, { pointerId: 1, button: 0, clientX: 400, clientY: 200 })
    expect(map.getAttribute('data-wheel-enabled')).toBe('true')

    fireEvent.wheel(map, { deltaY: -100, clientX: 400, clientY: 200 })
    expect(Number(map.getAttribute('data-zoom'))).toBeGreaterThan(Number(initialZoom))
  })

  it('disables wheel on leave and does not reactivate on enter alone', () => {
    const { map } = prepareMap()
    fireEvent.pointerDown(map, { pointerId: 2, button: 0, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(map, { pointerId: 2, button: 0, clientX: 220, clientY: 120 })
    expect(map.getAttribute('data-wheel-enabled')).toBe('true')

    fireEvent.pointerLeave(map, { pointerId: 2, clientX: 970, clientY: 120 })
    expect(map.getAttribute('data-wheel-enabled')).toBe('false')
    fireEvent.pointerEnter(map, { pointerId: 3, clientX: 200, clientY: 100 })

    const zoomAfterLeave = map.getAttribute('data-zoom')
    fireEvent.wheel(map, { deltaY: 100, clientX: 200, clientY: 100 })
    expect(map.getAttribute('data-zoom')).toBe(zoomAfterLeave)
  })
})
