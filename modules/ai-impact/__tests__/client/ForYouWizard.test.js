import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ForYouWizard from '../../client/components/ForYouWizard.vue'

describe('ForYouWizard', () => {
  const availableComponents = ['Platform Core', 'ML Models', 'Dashboard']

  function createWrapper(props = {}) {
    return mount(ForYouWizard, {
      props: { availableComponents, componentsLoading: false, ...props },
      global: { stubs: { Teleport: true, Transition: true } }
    })
  }

  it('renders Step 1 (mode selection) by default', () => {
    const wrapper = createWrapper()
    expect(wrapper.text()).toContain('Welcome to State of the Union')
    expect(wrapper.text()).toContain('Auto')
    expect(wrapper.text()).toContain('Manual')
  })

  it('emits skip when Skip is clicked', async () => {
    const wrapper = createWrapper()
    await wrapper.find('button').findAll('button').at(-1) // find Skip
    const skipBtn = wrapper.findAll('button').find(b => b.text().includes('Skip'))
    await skipBtn.trigger('click')
    expect(wrapper.emitted('skip')).toHaveLength(1)
  })

  it('emits skip on Escape key', async () => {
    const wrapper = createWrapper()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('skip')).toHaveLength(1)
  })

  it('Get Started button is disabled when no mode selected', () => {
    const wrapper = createWrapper()
    const getStartedBtn = wrapper.findAll('button').find(b => b.text().includes('Get Started'))
    expect(getStartedBtn.attributes('disabled')).toBeDefined()
  })

  it('emits complete with auto mode when Auto selected and Get Started clicked', async () => {
    const wrapper = createWrapper()
    // Click Auto card
    const autoBtn = wrapper.findAll('button').find(b => b.text().includes('Auto'))
    await autoBtn.trigger('click')
    // Click Get Started
    const getStartedBtn = wrapper.findAll('button').find(b => b.text().includes('Get Started'))
    await getStartedBtn.trigger('click')
    expect(wrapper.emitted('complete')).toHaveLength(1)
    expect(wrapper.emitted('complete')[0]).toEqual(['auto', []])
  })

  it('transitions to Step 2 when Manual selected and Next clicked', async () => {
    const wrapper = createWrapper()
    // Click Manual card
    const manualBtn = wrapper.findAll('button').find(b => b.text().includes('Manual'))
    await manualBtn.trigger('click')
    // Click Next
    const nextBtn = wrapper.findAll('button').find(b => b.text().includes('Next'))
    await nextBtn.trigger('click')
    expect(wrapper.text()).toContain('Choose Your Components')
  })

  it('Back button returns to Step 1 from Step 2', async () => {
    const wrapper = createWrapper()
    const manualBtn = wrapper.findAll('button').find(b => b.text().includes('Manual'))
    await manualBtn.trigger('click')
    const nextBtn = wrapper.findAll('button').find(b => b.text().includes('Next'))
    await nextBtn.trigger('click')
    // Now on Step 2
    const backBtn = wrapper.findAll('button').find(b => b.text().includes('Back'))
    await backBtn.trigger('click')
    expect(wrapper.text()).toContain('Welcome to State of the Union')
  })

  it('emits complete with manual mode and selected components from Step 2', async () => {
    const wrapper = createWrapper()
    // Go to step 2
    const manualBtn = wrapper.findAll('button').find(b => b.text().includes('Manual'))
    await manualBtn.trigger('click')
    const nextBtn = wrapper.findAll('button').find(b => b.text().includes('Next'))
    await nextBtn.trigger('click')

    // Select a component via checkbox
    const checkboxes = wrapper.findAll('input[type="checkbox"]')
    await checkboxes[0].setValue(true)

    // Click Get Started
    const getStartedBtn = wrapper.findAll('button').find(b => b.text().includes('Get Started'))
    await getStartedBtn.trigger('click')
    expect(wrapper.emitted('complete')).toHaveLength(1)
    expect(wrapper.emitted('complete')[0][0]).toBe('manual')
    expect(wrapper.emitted('complete')[0][1]).toEqual(['Platform Core'])
  })

  it('shows fallback message when no components available in Step 2', async () => {
    const wrapper = createWrapper({ availableComponents: [] })
    const manualBtn = wrapper.findAll('button').find(b => b.text().includes('Manual'))
    await manualBtn.trigger('click')
    const nextBtn = wrapper.findAll('button').find(b => b.text().includes('Next'))
    await nextBtn.trigger('click')
    expect(wrapper.text()).toContain('No components configured')
  })
})
