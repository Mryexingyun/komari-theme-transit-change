<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue/offline'
import { computed, onMounted, ref } from 'vue'
import { useNodeGeoClusters } from '@/composables/useNodeGeoClusters'
import { useAppStore } from '@/stores/app'

const props = defineProps<{
  nodes?: NodeData[]
}>()

const emit = defineEmits<{
  /** 点了某个地区：交给上层决定开哪台节点。 */
  openRegion: [uuid: string, code: string]
}>()

/**
 * 点亮地图：夜景底图 + 按国家整片点亮的轮廓。
 *
 * 轮廓是构建期从 world-atlas countries-50m 预投影、简化过的静态 JSON
 * （`public/images/world/countries.paths.json`，等距矩形 74°N ~ 50°S，126 KB），
 * 运行时零地理库依赖；哪些国家点亮由 `useNodeGeoClusters` 的区域代码决定。
 */

const WORLD_PATHS_URL = '/images/world/countries.paths.json'
const MAP_WIDTH = 1440
const MAP_HEIGHT = 720
const NORTH = 74
const SOUTH = -50
const EARTH_NIGHT_TEXTURE = '/images/earth/earth-night.jpg'
const SCAN_DURATION_MS = 1400

/** 地区代码 → 国家代码：港澳并进中国，让整个中国轮廓一起亮。 */
const REGION_COUNTRY_ALIAS: Record<string, string> = {
  HK: 'CN',
  MO: 'CN',
}

interface LitRegion {
  id: string
  code: string
  countryCode: string
  label: string
  servers: number
  onlineServers: number
  offlineServers: number
  rate: number
  x: number
  y: number
  lat: number
  uuid: string
  delayMs: number
}

interface LitCountry {
  code: string
  d: string
  servers: number
  onlineServers: number
  hash: number
  color: string
  edge: string
  halo: string
  scanDelayMs: number
  regionIds: string
}

interface WorldPaths {
  width: number
  height: number
  north: number
  south: number
  countries: Record<string, string>
}

const appStore = useAppStore()
const { displayNodes, regionClusters, totalServers, onlineServers, offlineServers } = useNodeGeoClusters({ nodes: () => props.nodes })

const hoveredId = ref('')
const pinnedId = ref('')
const world = ref<WorldPaths | null>(null)
const loadFailed = ref(false)

onMounted(async () => {
  try {
    const response = await fetch(WORLD_PATHS_URL)
    if (!response.ok)
      throw new Error(`HTTP ${response.status}`)
    world.value = await response.json() as WorldPaths
  }
  catch {
    loadFailed.value = true
  }
})

const onlineRate = computed(() => {
  if (totalServers.value === 0)
    return 0
  return Math.round((onlineServers.value / totalServers.value) * 100)
})

const coverageRate = computed(() => {
  const continents = new Set<string>()
  for (const cluster of regionClusters.value) {
    const [lat, lng] = cluster.coord
    if (lat >= 12)
      continents.add(lng < -30 ? 'na' : lng > 60 ? 'as' : 'eu')
    else if (lat <= -10)
      continents.add('sa')
    else
      continents.add(lng > 40 ? 'af' : 'sa')
  }
  return Math.round((continents.size / 6) * 100)
})

function project(coord: [number, number]) {
  const [lat, lng] = coord
  return {
    x: ((lng + 180) / 360) * MAP_WIDTH,
    y: ((NORTH - lat) / (NORTH - SOUTH)) * MAP_HEIGHT,
  }
}

/** 每台节点按国家聚合，点击国家时才知道该跳哪台。 */
const nodesByCountry = computed(() => {
  const map = new Map<string, NodeData[]>()
  for (const node of displayNodes.value) {
    const raw = node.region?.trim().toUpperCase() ?? ''
    if (!raw)
      continue
    const country = REGION_COUNTRY_ALIAS[raw] ?? raw
    const list = map.get(country) ?? []
    list.push(node)
    map.set(country, list)
  }
  return map
})

const litRegions = computed<LitRegion[]>(() => regionClusters.value.map((cluster, index) => {
  const point = project(cluster.coord)
  const offline = cluster.servers - cluster.onlineServers
  const rawCode = cluster.code.toUpperCase()
  const countryCode = REGION_COUNTRY_ALIAS[rawCode] ?? rawCode
  const nodes = nodesByCountry.value.get(countryCode) ?? []
  return {
    id: cluster.id,
    code: rawCode,
    countryCode,
    label: cluster.label || cluster.code,
    servers: cluster.servers,
    onlineServers: cluster.onlineServers,
    offlineServers: offline,
    rate: cluster.servers > 0 ? cluster.onlineServers / cluster.servers : 0,
    x: point.x,
    y: point.y,
    lat: cluster.coord[0],
    uuid: nodes[0]?.uuid ?? '',
    delayMs: (index % 6) * 420,
  }
}))

/**
 * 在线率 → 颜色：100% 深青，掉一台转琥珀，全离线转玫红。
 * 色相沿青(187) → 琥珀(45) → 玫红(350) 连续插值，不给离散三档。
 */
function ratePalette(rate: number) {
  let hue: number
  if (rate >= 0.999)
    hue = 187
  else if (rate > 0.5)
    hue = 45 + (187 - 45) * ((rate - 0.5) / 0.5)
  else
    hue = 350 + (45 - 350) * rate * 2
  const safeHue = Math.round((hue + 360) % 360)
  return {
    color: `hsl(${safeHue} 82% 58%)`,
    edge: `hsl(${safeHue} 92% 74%)`,
    halo: `hsl(${safeHue} 90% 60%)`,
  }
}

/** 国家 → 聚合后的点亮片（同国多个地区合并成一片）。 */
const litCountries = computed<LitCountry[]>(() => {
  const paths = world.value?.countries
  if (!paths)
    return []
  const byCountry = new Map<string, { servers: number, online: number, latSum: number, count: number, regionIds: string[] }>()
  for (const region of litRegions.value) {
    const entry = byCountry.get(region.countryCode) ?? { servers: 0, online: 0, latSum: 0, count: 0, regionIds: [] }
    entry.servers += region.servers
    entry.online += region.onlineServers
    entry.latSum += region.lat
    entry.count += 1
    entry.regionIds.push(region.id)
    byCountry.set(region.countryCode, entry)
  }

  const result: LitCountry[] = []
  for (const [code, entry] of byCountry) {
    const d = paths[code]
    if (!d)
      continue
    const rate = entry.servers > 0 ? entry.online / entry.servers : 0
    const palette = ratePalette(rate)
    const centerLat = entry.latSum / Math.max(1, entry.count)
    result.push({
      code,
      d,
      servers: entry.servers,
      onlineServers: entry.online,
      hash: 0,
      color: palette.color,
      edge: palette.edge,
      halo: palette.halo,
      // 赤道先亮、越靠近两极越晚：像一次从中间扫出去的扫描。
      scanDelayMs: Math.round((Math.abs(centerLat) / 90) * SCAN_DURATION_MS),
      regionIds: entry.regionIds.join(','),
    })
  }
  return result.sort((a, b) => a.scanDelayMs - b.scanDelayMs)
})

/** 有独立轮廓的国家（50m 下港澳新都有，剩下的极小地区才走圆片）。 */
const fallbackRegions = computed(() => {
  const paths = world.value?.countries
  if (!paths)
    return litRegions.value
  return litRegions.value.filter(region => !paths[region.countryCode])
})

const baseShapes = computed(() => {
  const paths = world.value?.countries
  if (!paths)
    return []
  const lit = new Set(litCountries.value.map(item => item.code))
  return Object.entries(paths)
    .filter(([code]) => !lit.has(code))
    .map(([code, d]) => ({ code, d }))
})

const activeRegion = computed(() => {
  const id = pinnedId.value || hoveredId.value
  if (!id)
    return null
  return litRegions.value.find(region => region.id === id) ?? null
})

/** 东亚一带区域挨得近，标签按 x 排序做纵向避让，避免叠成一团。 */
const labelPositions = computed(() => {
  const sorted = [...litRegions.value].sort((a, b) => a.x - b.x || a.y - b.y)
  const accepted: Array<{ x: number, y: number }> = []
  const result = new Map<string, number>()
  for (const region of sorted) {
    let y = region.y - 18
    for (let guard = 0; guard < 6; guard++) {
      const collides = accepted.some(item => Math.abs(item.x - region.x) < 84 && Math.abs(item.y - y) < 15)
      if (!collides)
        break
      y -= 15
    }
    accepted.push({ x: region.x, y })
    result.set(region.id, y)
  }
  return result
})

function selectRegion(region: LitRegion) {
  pinnedId.value = pinnedId.value === region.id ? '' : region.id
}

function openRegion(region: LitRegion) {
  if (region.uuid)
    emit('openRegion', region.uuid, region.code)
}

function regionLabelForCountry(country: LitCountry) {
  return country.regionIds
    .split(',')
    .map(id => litRegions.value.find(region => region.id === id)?.label ?? '')
    .filter(Boolean)
    .join(' / ')
}
</script>

<template>
  <div class="coverage-map relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-white/25 bg-slate-950/80 shadow-[0_24px_80px_rgb(2_6_23/0.45)]">
    <div class="flex min-h-0 flex-1">
      <div class="relative min-w-0 flex-1">
        <svg
          class="size-full"
          :viewBox="`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`"
          preserveAspectRatio="xMidYMid slice"
          role="img"
          aria-label="按国家点亮的节点覆盖地图"
        >
          <defs>
            <linearGradient id="lit-sheen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3" />
              <stop offset="55%" stop-color="#ffffff" stop-opacity="0.05" />
              <stop offset="100%" stop-color="#000000" stop-opacity="0.16" />
            </linearGradient>
            <linearGradient id="coverage-vignette" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#020617" stop-opacity="0.36" />
              <stop offset="50%" stop-color="#020617" stop-opacity="0.1" />
              <stop offset="100%" stop-color="#020617" stop-opacity="0.55" />
            </linearGradient>
            <filter id="lit-glow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="6" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="lit-halo" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="9" />
            </filter>
          </defs>

          <image
            :href="EARTH_NIGHT_TEXTURE"
            x="0"
            y="0"
            :width="MAP_WIDTH"
            :height="MAP_HEIGHT"
            preserveAspectRatio="none"
            class="coverage-texture"
          />
          <rect :width="MAP_WIDTH" :height="MAP_HEIGHT" fill="url(#coverage-vignette)" />
          <g class="coverage-grid">
            <line v-for="lng in 11" :key="`m-${lng}`" :x1="(lng - 1) * 144" y1="0" :x2="(lng - 1) * 144" :y2="MAP_HEIGHT" />
            <line v-for="lat in 7" :key="`p-${lat}`" x1="0" :y1="(lat - 1) * 120" :x2="MAP_WIDTH" :y2="(lat - 1) * 120" />
          </g>

          <g class="coverage-base">
            <path v-for="shape in baseShapes" :key="`base-${shape.code}`" :d="shape.d" />
          </g>

          <!-- 点亮国家：整片填充 + 外发光，打开时从赤道向两极依次扫亮 -->
          <g
            v-for="country in litCountries"
            :key="`lit-${country.code}`"
            class="coverage-shape"
            :class="activeRegion && country.regionIds.split(',').includes(activeRegion.id) && 'is-active'"
            :style="{
              '--lit-color': country.color,
              '--lit-edge': country.edge,
              '--lit-halo': country.halo,
              '--scan-delay': `${country.scanDelayMs}ms`,
            }"
            role="button"
            tabindex="0"
            :aria-label="`${regionLabelForCountry(country)}：${country.onlineServers} 在线，${country.servers - country.onlineServers} 离线`"
            @click="openRegion(litRegions.find(region => country.regionIds.split(',').includes(region.id))!)"
            @keydown.enter.prevent="openRegion(litRegions.find(region => country.regionIds.split(',').includes(region.id))!)"
          >
            <path :d="country.d" class="shape-halo" filter="url(#lit-halo)" />
            <path :d="country.d" class="shape-fill" />
            <path :d="country.d" class="shape-sheen" />
            <path :d="country.d" class="shape-edge" filter="url(#lit-glow)" />
          </g>

          <!-- 极少数没有独立轮廓的地区：发光圆片兜底 -->
          <g
            v-for="region in fallbackRegions"
            :key="`dot-${region.id}`"
            class="coverage-shape is-dot"
            :class="[activeRegion?.id === region.id && 'is-active']"
            :style="{
              '--lit-color': ratePalette(region.rate).color,
              '--lit-edge': ratePalette(region.rate).edge,
              '--lit-halo': ratePalette(region.rate).halo,
              '--scan-delay': `${Math.round((Math.abs(region.lat) / 90) * SCAN_DURATION_MS)}ms`,
            }"
            role="button"
            tabindex="0"
            :aria-label="`${region.label}：${region.onlineServers} 在线，${region.offlineServers} 离线`"
            @mouseenter="hoveredId = region.id"
            @mouseleave="hoveredId = ''"
            @click="selectRegion(region)"
            @keydown.enter.prevent="selectRegion(region)"
          >
            <circle :cx="region.x" :cy="region.y" r="20" class="shape-halo" filter="url(#lit-halo)" />
            <circle :cx="region.x" :cy="region.y" r="13" class="shape-fill" />
            <circle :cx="region.x" :cy="region.y" r="13" class="shape-edge" filter="url(#lit-glow)" />
          </g>

          <!-- 节点位置与地区名：光晕上的锚点，不是主角 -->
          <g
            v-for="region in litRegions"
            :key="`pin-${region.id}`"
            class="coverage-pin"
            :class="activeRegion?.id === region.id && 'is-active'"
            @mouseenter="hoveredId = region.id"
            @mouseleave="hoveredId = ''"
            @click="selectRegion(region)"
            @dblclick="openRegion(region)"
          >
            <circle :cx="region.x" :cy="region.y" r="5.4" class="pin-halo" />
            <circle :cx="region.x" :cy="region.y" r="2.6" class="pin-core" />
            <text
              :x="region.x"
              :y="labelPositions.get(region.id) ?? region.y - 18"
              text-anchor="middle"
              class="coverage-label"
            >{{ region.label }}</text>
          </g>
        </svg>

        <div class="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-center gap-2 p-3 sm:p-4">
          <span class="coverage-chip is-primary">
            <Icon icon="tabler:world" width="14" height="14" />
            点亮地图
          </span>
          <span class="coverage-chip">
            <span class="coverage-dot is-online" />
            {{ onlineServers }} 在线
          </span>
          <span v-if="offlineServers > 0" class="coverage-chip">
            <span class="coverage-dot is-offline" />
            {{ offlineServers }} 离线
          </span>
          <span class="coverage-chip">{{ litCountries.length }} 个国家/地区</span>
          <span class="coverage-chip">{{ coverageRate }}% 覆盖</span>
          <span v-if="loadFailed" class="coverage-chip border-amber-400/40 text-amber-200">
            轮廓数据未加载，已退回圆片显示
          </span>
        </div>

        <div
          v-if="activeRegion"
          class="absolute bottom-3 left-3 max-w-[17rem] rounded-xl border border-white/20 bg-slate-950/85 px-3 py-2 text-xs text-slate-100 shadow-xl backdrop-blur-md sm:bottom-4 sm:left-4"
        >
          <div class="flex items-center gap-1.5 font-semibold">
            <img v-if="activeRegion.code" :src="`/images/flags/${activeRegion.code}.svg`" :alt="activeRegion.code" class="size-3.5 rounded-[2px] object-cover">
            {{ activeRegion.label }}
          </div>
          <div class="mt-1 flex items-center gap-2 text-[11px] text-slate-300">
            <span class="text-emerald-300">{{ activeRegion.onlineServers }} 在线</span>
            <span v-if="activeRegion.offlineServers > 0" class="text-rose-300">{{ activeRegion.offlineServers }} 离线</span>
            <span>{{ activeRegion.servers }} 台</span>
          </div>
          <button
            v-if="activeRegion.uuid"
            type="button"
            class="mt-1.5 inline-flex items-center gap-1 rounded-md border border-cyan-400/40 bg-cyan-500/10 px-2 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/20"
            @click="openRegion(activeRegion)"
          >
            <Icon icon="tabler:arrow-right" width="12" height="12" />
            打开该地区节点
          </button>
        </div>
      </div>

      <aside class="hidden w-40 shrink-0 flex-col gap-1 overflow-y-auto border-l border-white/10 bg-slate-950/40 p-2 sm:flex lg:w-44">
        <div class="mb-1 px-0.5 text-[10px] font-bold tracking-[0.2em] text-cyan-200/70">
          REGIONS
        </div>
        <button
          v-for="region in litRegions"
          :key="`legend-${region.id}`"
          type="button"
          class="coverage-legend-item"
          :class="pinnedId === region.id && 'is-active'"
          :style="{ '--legend-color': ratePalette(region.rate).color }"
          @click="selectRegion(region)"
          @mouseenter="hoveredId = region.id"
          @mouseleave="hoveredId = ''"
        >
          <span class="coverage-legend-dot" />
          <span class="truncate">{{ region.label }}</span>
          <span class="ml-auto tabular-nums text-[10px] opacity-80">{{ region.onlineServers }}/{{ region.servers }}</span>
        </button>
      </aside>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 px-3 py-2 text-[11px] text-slate-300/80 sm:px-4">
      <span>在线率 {{ onlineRate }}% · 共 {{ totalServers }} 台节点</span>
      <span class="text-slate-400/70">点击国家打开该地区节点 · {{ appStore.lang === 'zh-CN' ? '轮廓：world-atlas 50m' : 'borders: world-atlas 50m' }}</span>
    </div>
  </div>
</template>

<style scoped>
.coverage-texture {
  filter: saturate(1.1) contrast(1.1) brightness(0.62);
  opacity: 0.9;
}

.coverage-grid line {
  stroke: rgb(148 163 184 / 0.1);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.coverage-base path {
  fill: rgb(148 163 184 / 0.06);
  stroke: rgb(148 163 184 / 0.18);
  stroke-width: 0.5;
  vector-effect: non-scaling-stroke;
}

.coverage-shape {
  cursor: pointer;
  outline: none;
  animation: lit-scan 0.62s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  animation-delay: var(--scan-delay);
}

.shape-fill {
  fill: var(--lit-color);
  fill-opacity: 0.42;
  stroke: none;
  animation: lit-breathe 5.2s ease-in-out infinite;
  animation-delay: var(--scan-delay);
}

.shape-sheen {
  fill: url(#lit-sheen);
  pointer-events: none;
}

.shape-edge {
  fill: none;
  stroke: var(--lit-edge);
  stroke-width: 1.2;
  vector-effect: non-scaling-stroke;
}

.shape-halo {
  fill: none;
  stroke: var(--lit-halo);
  stroke-width: 6;
  stroke-opacity: 0.5;
  vector-effect: non-scaling-stroke;
}

.coverage-shape.is-active .shape-edge {
  stroke-width: 2.4;
  stroke: rgb(255 255 255 / 0.95);
}

.coverage-shape.is-active .shape-halo {
  stroke-width: 10;
  stroke-opacity: 0.8;
}

.coverage-shape.is-active .shape-fill {
  fill-opacity: 0.62;
}

.coverage-shape.is-dot .shape-fill {
  fill: var(--lit-color);
  fill-opacity: 0.45;
}

.coverage-pin {
  cursor: pointer;
}

.pin-halo {
  fill: var(--lit-halo, rgb(34 211 238));
  fill-opacity: 0.3;
}

.pin-core {
  fill: rgb(240 253 255 / 0.95);
  stroke: rgb(8 47 73 / 0.65);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.coverage-pin.is-active .pin-core {
  fill: #fff;
}

.coverage-label {
  fill: rgb(226 232 240 / 0.95);
  font-size: 12px;
  font-weight: 700;
  paint-order: stroke;
  stroke: rgb(2 6 23 / 0.9);
  stroke-width: 2.8px;
  stroke-linejoin: round;
  pointer-events: none;
}

.coverage-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  border: 1px solid rgb(148 163 184 / 0.24);
  border-radius: 999px;
  background: rgb(2 6 23 / 0.62);
  padding: 0.18rem 0.6rem;
  color: rgb(203 213 225 / 0.92);
  font-size: 11px;
  font-weight: 600;
  backdrop-filter: blur(10px);
}

.coverage-chip.is-primary {
  border-color: rgb(34 211 238 / 0.4);
  color: rgb(165 243 252 / 0.95);
  letter-spacing: 0.08em;
}

.coverage-dot {
  width: 0.36rem;
  height: 0.36rem;
  border-radius: 999px;
}

.coverage-dot.is-online {
  background: rgb(52 211 153);
  box-shadow: 0 0 8px rgb(52 211 153 / 0.9);
}

.coverage-dot.is-offline {
  background: rgb(251 113 133);
  box-shadow: 0 0 8px rgb(251 113 133 / 0.8);
}

.coverage-legend-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  border: 1px solid rgb(148 163 184 / 0.18);
  border-radius: 0.5rem;
  background: rgb(2 6 23 / 0.55);
  padding: 0.2rem 0.42rem;
  color: rgb(226 232 240 / 0.9);
  font-size: 11px;
  font-weight: 600;
  text-align: left;
  backdrop-filter: blur(8px);
  transition:
    border-color 0.2s ease,
    background 0.2s ease;
}

.coverage-legend-item:hover,
.coverage-legend-item.is-active {
  border-color: rgb(34 211 238 / 0.55);
  background: rgb(8 47 73 / 0.72);
}

.coverage-legend-dot {
  width: 0.4rem;
  height: 0.4rem;
  flex: none;
  border-radius: 999px;
  background: var(--legend-color, rgb(94 234 212));
  box-shadow: 0 0 8px var(--legend-color, rgb(94 234 212));
}

@keyframes lit-scan {
  0% {
    opacity: 0;
  }

  100% {
    opacity: 1;
  }
}

@keyframes lit-breathe {
  0%,
  100% {
    fill-opacity: 0.36;
  }

  50% {
    fill-opacity: 0.55;
  }
}

@media (prefers-reduced-motion: reduce) {
  .coverage-shape {
    animation: none;
  }

  .shape-fill {
    animation: none;
    fill-opacity: 0.45;
  }
}
</style>
