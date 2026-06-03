<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import ForYouComponentPicker from './ForYouComponentPicker.vue'

defineProps({
  availableComponents: { type: Array, default: () => [] },
  componentsLoading: { type: Boolean, default: false },
  show: { type: Boolean, default: true }
})

const emit = defineEmits(['complete', 'skip'])

const step = ref(1)
const selectedMode = ref(null)
const selectedComponents = ref([])

function handleSkip() {
  emit('skip')
}

function handleGetStarted() {
  if (selectedMode.value === 'auto') {
    emit('complete', 'auto', [])
  } else if (selectedMode.value === 'manual' && step.value === 1) {
    step.value = 2
  } else if (selectedMode.value === 'manual' && step.value === 2) {
    emit('complete', 'manual', selectedComponents.value)
  }
}

function handleBack() {
  step.value = 1
}

function handleKeydown(e) {
  if (e.key === 'Escape') handleSkip()
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/50" @click="handleSkip" />

        <!-- Modal -->
        <div class="relative bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-lg w-full">
          <!-- Step 1: Mode Selection -->
          <div v-if="step === 1" class="p-6">
            <h2 class="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">Welcome to State of the Union</h2>
            <p class="text-sm text-gray-500 dark:text-gray-400 mb-6">
              Get a personalized view of RFEs and features that matter to you. Choose how to select your components.
            </p>

            <div class="space-y-3 mb-6">
              <!-- Auto card -->
              <button
                @click="selectedMode = 'auto'"
                type="button"
                class="w-full text-left p-4 rounded-lg border-2 transition-colors"
                :class="selectedMode === 'auto'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                  : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'"
              >
                <div class="flex items-center gap-3">
                  <div class="shrink-0 w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center">
                    <svg class="h-5 w-5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                  </div>
                  <div>
                    <p class="font-medium text-gray-900 dark:text-gray-100">Auto</p>
                    <p class="text-sm text-gray-500 dark:text-gray-400">Match items to your roster components automatically</p>
                  </div>
                </div>
              </button>

              <!-- Manual card -->
              <button
                @click="selectedMode = 'manual'"
                type="button"
                class="w-full text-left p-4 rounded-lg border-2 transition-colors"
                :class="selectedMode === 'manual'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                  : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'"
              >
                <div class="flex items-center gap-3">
                  <div class="shrink-0 w-10 h-10 rounded-lg bg-purple-100 dark:bg-purple-900/50 flex items-center justify-center">
                    <svg class="h-5 w-5 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                    </svg>
                  </div>
                  <div>
                    <p class="font-medium text-gray-900 dark:text-gray-100">Manual</p>
                    <p class="text-sm text-gray-500 dark:text-gray-400">Choose the components you care about</p>
                  </div>
                </div>
              </button>
            </div>

            <div class="flex items-center justify-between">
              <button @click="handleSkip" type="button" class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">
                Skip
              </button>
              <button
                @click="handleGetStarted"
                :disabled="!selectedMode"
                type="button"
                class="px-4 py-2 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {{ selectedMode === 'manual' ? 'Next' : 'Get Started' }}
              </button>
            </div>
          </div>

          <!-- Step 2: Component Picker (manual only) -->
          <div v-else class="p-6">
            <h2 class="text-lg font-bold text-gray-900 dark:text-gray-100 mb-2">Choose Your Components</h2>
            <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Select the components you want to track. You can change these later in settings.
            </p>

            <template v-if="!componentsLoading && availableComponents.length === 0">
              <p class="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">
                No components configured. Try Auto mode instead.
              </p>
            </template>

            <ForYouComponentPicker
              v-else
              :availableComponents="availableComponents"
              v-model="selectedComponents"
              :loading="componentsLoading"
            />

            <div class="flex items-center justify-between mt-6">
              <button @click="handleBack" type="button" class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">
                Back
              </button>
              <button
                @click="handleGetStarted"
                type="button"
                class="px-4 py-2 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
              >
                Get Started
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
</style>
