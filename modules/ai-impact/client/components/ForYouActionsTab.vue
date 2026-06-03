<script setup>
import { ref } from 'vue'
import ForYouStats from './ForYouStats.vue'
import ForYouCard from './ForYouCard.vue'
import ForYouMultiSelect from './ForYouMultiSelect.vue'

defineProps({
  actionNeeded: { type: Array, default: () => [] },
  actionGroups: { type: Array, default: () => [] },
  everythingElse: { type: Array, default: () => [] },
  stats: { type: Object, default: () => ({}) },
  stageFilter: { type: Array, default: () => [] },
  priorityFilter: { type: Array, default: () => [] },
  stageOptions: { type: Array, default: () => [] },
  priorityOptions: { type: Array, default: () => [] },
  componentFilter: { type: Array, default: () => [] },
  availableItemComponents: { type: Array, default: () => [] },
  jiraHost: { type: String, default: null }
})

const emit = defineEmits(['navigate', 'update:stageFilter', 'update:priorityFilter', 'update:componentFilter'])

const expandedGroups = ref({})
const showEverythingElse = ref(false)

function toggleGroup(id) {
  expandedGroups.value[id] = !expandedGroups.value[id]
}
</script>

<template>
  <div class="space-y-6">
    <!-- Stats -->
    <ForYouStats :stats="stats" />

    <!-- Filters -->
    <div class="flex items-center gap-3">
      <ForYouMultiSelect
        :modelValue="stageFilter"
        :options="stageOptions"
        placeholder="All Stages"
        @update:modelValue="emit('update:stageFilter', $event)"
      />
      <ForYouMultiSelect
        :modelValue="priorityFilter"
        :options="priorityOptions"
        placeholder="All Priorities"
        @update:modelValue="emit('update:priorityFilter', $event)"
      />
      <ForYouMultiSelect
        v-if="availableItemComponents.length > 0"
        :modelValue="componentFilter"
        :options="availableItemComponents"
        placeholder="All Components"
        @update:modelValue="emit('update:componentFilter', $event)"
      />
    </div>

    <!-- Hero card -->
    <div v-if="actionNeeded.length > 0">
      <p class="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Most Urgent</p>
      <ForYouCard
        :item="actionNeeded[0]"
        :jiraHost="jiraHost"
        :hero="true"
        @navigate="emit('navigate', $event)"
      />
    </div>

    <!-- Action groups -->
    <section v-if="actionGroups.length > 0">
      <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">Action Needed</h2>
      <div class="space-y-2">
        <div v-for="group in actionGroups" :key="group.id">
          <button
            @click="toggleGroup(group.id)"
            class="w-full flex items-center justify-between px-4 py-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
          >
            <div class="flex items-center gap-2">
              <svg
                class="h-4 w-4 text-gray-400 transition-transform"
                :class="{ 'rotate-90': expandedGroups[group.id] }"
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
              <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ group.label }}</span>
            </div>
            <span class="text-sm font-semibold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-full">{{ group.items.length }}</span>
          </button>
          <div v-if="expandedGroups[group.id]" class="mt-2 space-y-2 pl-2">
            <ForYouCard
              v-for="item in group.items"
              :key="item.key"
              :item="item"
              :jiraHost="jiraHost"
              @navigate="emit('navigate', $event)"
            />
          </div>
        </div>
      </div>
    </section>

    <div v-else class="text-sm text-gray-500 dark:text-gray-400 py-4 text-center bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
      No items need your attention right now
    </div>

    <!-- Everything Else (collapsed) -->
    <section>
      <button
        @click="showEverythingElse = !showEverythingElse"
        class="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-gray-700 dark:hover:text-gray-300"
      >
        <svg
          class="h-4 w-4 transition-transform"
          :class="{ 'rotate-90': showEverythingElse }"
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
        Everything Else
        <span class="text-sm font-normal text-gray-500 dark:text-gray-400">({{ everythingElse.length }})</span>
      </button>
      <div v-if="showEverythingElse" class="mt-3 space-y-3">
        <div v-if="everythingElse.length === 0" class="text-sm text-gray-500 dark:text-gray-400 py-4 text-center bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          No other items
        </div>
        <ForYouCard
          v-for="item in everythingElse"
          :key="item.key"
          :item="item"
          :jiraHost="jiraHost"
          @navigate="emit('navigate', $event)"
        />
      </div>
    </section>
  </div>
</template>
