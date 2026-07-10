<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'

const target = ref<HTMLElement | null>(null)
const isVisible = ref(false)
const currentLine = ref(-1)
const isPlaying = ref(false)
const hasPlayed = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

type LineType = 'server' | 'client' | 'annotation' | 'blank' | 'phase-sep'

interface SmtpLine {
  type: LineType
  text: string
  phase: string
  delay: number
  /** For rich rendering inside DATA */
  semantic?: 'command' | 'header' | 'body' | 'terminator'
}

const lines: SmtpLine[] = [
  // Connection phase
  { type: 'server', text: '220 mx.example.com ESMTP ready', phase: 'connection', delay: 600 },
  { type: 'client', text: 'EHLO mail.sender.com', phase: 'connection', delay: 500, semantic: 'command' },
  { type: 'server', text: '250-mx.example.com Hello', phase: 'connection', delay: 300 },
  { type: 'server', text: '250-SIZE 35882577', phase: 'connection', delay: 150 },
  { type: 'server', text: '250-STARTTLS', phase: 'connection', delay: 150 },
  { type: 'server', text: '250 OK', phase: 'connection', delay: 300 },

  // TLS phase
  { type: 'phase-sep', text: '', phase: 'tls', delay: 200 },
  { type: 'client', text: 'STARTTLS', phase: 'tls', delay: 500, semantic: 'command' },
  { type: 'server', text: '220 Ready to start TLS', phase: 'tls', delay: 400 },
  { type: 'annotation', text: 'TLS handshake — connection is now encrypted', phase: 'tls', delay: 1400 },
  { type: 'client', text: 'EHLO mail.sender.com', phase: 'tls', delay: 500, semantic: 'command' },
  { type: 'server', text: '250 OK', phase: 'tls', delay: 300 },

  // Envelope phase
  { type: 'phase-sep', text: '', phase: 'envelope', delay: 200 },
  { type: 'client', text: 'MAIL FROM:<alice@sender.com>', phase: 'envelope', delay: 500, semantic: 'command' },
  { type: 'server', text: '250 OK', phase: 'envelope', delay: 300 },
  { type: 'client', text: 'RCPT TO:<bob@example.com>', phase: 'envelope', delay: 500, semantic: 'command' },
  { type: 'server', text: '250 OK', phase: 'envelope', delay: 300 },

  // Data phase
  { type: 'phase-sep', text: '', phase: 'data', delay: 200 },
  { type: 'client', text: 'DATA', phase: 'data', delay: 500, semantic: 'command' },
  { type: 'server', text: '354 Start mail input', phase: 'data', delay: 400 },
  { type: 'client', text: 'From: Alice <alice@sender.com>', phase: 'data', delay: 350, semantic: 'header' },
  { type: 'client', text: 'To: Bob <bob@example.com>', phase: 'data', delay: 250, semantic: 'header' },
  { type: 'client', text: 'Subject: Hello!', phase: 'data', delay: 250, semantic: 'header' },
  { type: 'client', text: 'Date: Sat, 22 Mar 2026 10:00:00 +0000', phase: 'data', delay: 250, semantic: 'header' },
  { type: 'blank', text: '', phase: 'data', delay: 200 },
  { type: 'client', text: 'Hi Bob, how are you?', phase: 'data', delay: 500, semantic: 'body' },
  { type: 'client', text: '.', phase: 'data', delay: 700, semantic: 'terminator' },
  { type: 'server', text: '250 OK: queued as 12345', phase: 'data', delay: 500 },

  // Quit phase
  { type: 'phase-sep', text: '', phase: 'quit', delay: 200 },
  { type: 'client', text: 'QUIT', phase: 'quit', delay: 400, semantic: 'command' },
  { type: 'server', text: '221 Bye', phase: 'quit', delay: 400 },
]

const phases = [
  { key: 'connection', label: 'Connect', color: 'brand', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
  { key: 'tls', label: 'Encrypt', color: 'warning', icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z' },
  { key: 'envelope', label: 'Envelope', color: 'info', icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
  { key: 'data', label: 'Message', color: 'accent', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
  { key: 'quit', label: 'Close', color: 'success', icon: 'M5 13l4 4L19 7' },
]

const currentPhase = computed(() => {
  if (currentLine.value < 0) return null
  return lines[currentLine.value]?.phase ?? null
})

/** Email preview data that builds up during the DATA phase */
const emailPreview = computed(() => {
  const visible = lines.slice(0, currentLine.value + 1)
  const from = visible.find(l => l.semantic === 'header' && l.text.startsWith('From:'))
  const to = visible.find(l => l.semantic === 'header' && l.text.startsWith('To:'))
  const subject = visible.find(l => l.semantic === 'header' && l.text.startsWith('Subject:'))
  const body = visible.find(l => l.semantic === 'body')
  const queued = visible.find(l => l.type === 'server' && l.text.includes('queued'))

  if (!from && !to && !subject && !body) return null

  return {
    from: from ? from.text.replace('From: ', '') : null,
    to: to ? to.text.replace('To: ', '') : null,
    subject: subject ? subject.text.replace('Subject: ', '') : null,
    body: body ? body.text : null,
    queued: !!queued,
  }
})

/** Whether TLS handshake annotation is currently showing or has shown */
const tlsActive = computed(() => {
  const tlsIdx = lines.findIndex(l => l.type === 'annotation')
  return tlsIdx >= 0 && currentLine.value >= tlsIdx
})

function showNextLine() {
  if (currentLine.value >= lines.length - 1) {
    isPlaying.value = false
    hasPlayed.value = true
    return
  }
  currentLine.value++
  const nextLine = lines[currentLine.value + 1]
  if (nextLine) {
    timer = setTimeout(showNextLine, nextLine.delay)
  } else {
    isPlaying.value = false
    hasPlayed.value = true
  }
}

function play() {
  if (isPlaying.value) return
  currentLine.value = -1
  isPlaying.value = true
  hasPlayed.value = false
  timer = setTimeout(showNextLine, lines[0]?.delay ?? 0)
}

function showAll() {
  if (timer) clearTimeout(timer)
  currentLine.value = lines.length - 1
  isPlaying.value = false
  hasPlayed.value = true
}

function phaseIndex(key: string) {
  return phases.findIndex(p => p.key === key)
}

function isPhaseReached(key: string) {
  if (currentLine.value < 0) return false
  const firstLineOfPhase = lines.findIndex(l => l.phase === key)
  return firstLineOfPhase <= currentLine.value
}

/** Parse server response into status code + rest */
function parseServerText(text: string): { code: string; rest: string } {
  const match = text.match(/^(\d{3}[-\s]?)(.*)$/)
  if (match) return { code: match[1] ?? '', rest: match[2] ?? '' }
  return { code: '', rest: text }
}

/** Parse client command into keyword + args */
function parseClientCommand(text: string): { keyword: string; args: string } | null {
  const commands = ['EHLO', 'STARTTLS', 'MAIL FROM:', 'RCPT TO:', 'DATA', 'QUIT']
  for (const cmd of commands) {
    if (text.startsWith(cmd)) {
      return { keyword: cmd, args: text.slice(cmd.length) }
    }
  }
  return null
}

/** Parse a header line into key + value */
function parseHeader(text: string): { key: string; value: string } | null {
  const idx = text.indexOf(':')
  if (idx < 0) return null
  return { key: text.slice(0, idx + 1), value: text.slice(idx + 1) }
}

onMounted(() => {
  if (!target.value) return
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) {
        isVisible.value = true
        observer.disconnect()
        setTimeout(play, 400)
      }
    },
    { threshold: 0.15 },
  )
  observer.observe(target.value)
  onUnmounted(() => {
    observer.disconnect()
    if (timer) clearTimeout(timer)
  })
})
</script>

<template>
  <div ref="target" class="smtp" :class="{ 'is-visible': isVisible }">
    <!-- Phase progress bar -->
    <div class="smtp-phases">
      <template v-for="(phase, pi) in phases" :key="phase.key">
        <div
          class="smtp-phase"
          :class="[
            `smtp-phase--${phase.color}`,
            { 'smtp-phase--active': currentPhase === phase.key },
            { 'smtp-phase--reached': isPhaseReached(phase.key) },
          ]"
        >
          <div class="smtp-phase-icon">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path :d="phase.icon" />
            </svg>
          </div>
          <span class="smtp-phase-label">{{ phase.label }}</span>
        </div>
        <!-- Connector between phases -->
        <div
          v-if="pi < phases.length - 1"
          class="smtp-phase-connector"
          :class="{ 'smtp-phase-connector--active': isPhaseReached(phases[pi + 1]?.key ?? '') }"
        />
      </template>
    </div>

    <div class="smtp-layout">
      <!-- Terminal window -->
      <div class="smtp-terminal">
        <div class="smtp-chrome">
          <div class="smtp-dots">
            <span /><span /><span />
          </div>
          <span class="smtp-title">
            <svg v-if="tlsActive" class="smtp-lock" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
            mx.example.com:25
          </span>
          <div class="smtp-controls">
            <button v-if="hasPlayed" class="smtp-btn" title="Replay" @click="play">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </button>
            <button v-if="isPlaying" class="smtp-btn" title="Skip to end" @click="showAll">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="5 4 15 12 5 20 5 4" />
                <line x1="19" y1="5" x2="19" y2="19" />
              </svg>
            </button>
          </div>
        </div>

        <div class="smtp-body">
          <!-- Cursor blinking before anything appears -->
          <div v-if="currentLine < 0 && isPlaying" class="smtp-line smtp-line--cursor">
            <span class="smtp-cursor" />
          </div>

          <template v-for="(line, i) in lines" :key="i">
            <!-- Phase separator -->
            <div v-if="line.type === 'phase-sep' && i <= currentLine" class="smtp-sep" />

            <!-- Server line -->
            <div
              v-else-if="line.type === 'server' && i <= currentLine"
              class="smtp-line smtp-line--server"
              :class="{ 'smtp-line--latest': i === currentLine && isPlaying }"
            >
              <span class="smtp-prefix smtp-prefix--server">S</span>
              <span class="smtp-text">
                <span class="smtp-code smtp-code--server">{{ parseServerText(line.text).code }}</span>
                <span class="smtp-rest smtp-rest--server">{{ parseServerText(line.text).rest }}</span>
              </span>
              <span v-if="i === currentLine && isPlaying" class="smtp-cursor" />
            </div>

            <!-- Client line: command -->
            <div
              v-else-if="line.type === 'client' && line.semantic === 'command' && i <= currentLine"
              class="smtp-line smtp-line--client"
              :class="{ 'smtp-line--latest': i === currentLine && isPlaying }"
            >
              <span class="smtp-prefix smtp-prefix--client">C</span>
              <span class="smtp-text">
                <template v-if="parseClientCommand(line.text)">
                  <span class="smtp-keyword">{{ parseClientCommand(line.text)!.keyword }}</span>
                  <span class="smtp-args">{{ parseClientCommand(line.text)!.args }}</span>
                </template>
                <span v-else class="smtp-rest smtp-rest--client">{{ line.text }}</span>
              </span>
              <span v-if="i === currentLine && isPlaying" class="smtp-cursor" />
            </div>

            <!-- Client line: header -->
            <div
              v-else-if="line.type === 'client' && line.semantic === 'header' && i <= currentLine"
              class="smtp-line smtp-line--client smtp-line--header"
              :class="{ 'smtp-line--latest': i === currentLine && isPlaying }"
            >
              <span class="smtp-prefix smtp-prefix--client">C</span>
              <span class="smtp-text">
                <span class="smtp-header-key">{{ parseHeader(line.text)?.key }}</span>
                <span class="smtp-header-val">{{ parseHeader(line.text)?.value }}</span>
              </span>
              <span v-if="i === currentLine && isPlaying" class="smtp-cursor" />
            </div>

            <!-- Client line: body -->
            <div
              v-else-if="line.type === 'client' && line.semantic === 'body' && i <= currentLine"
              class="smtp-line smtp-line--client smtp-line--body"
              :class="{ 'smtp-line--latest': i === currentLine && isPlaying }"
            >
              <span class="smtp-prefix smtp-prefix--client">C</span>
              <span class="smtp-text smtp-body-text">{{ line.text }}</span>
              <span v-if="i === currentLine && isPlaying" class="smtp-cursor" />
            </div>

            <!-- Client line: terminator (.) -->
            <div
              v-else-if="line.type === 'client' && line.semantic === 'terminator' && i <= currentLine"
              class="smtp-line smtp-line--client smtp-line--terminator"
              :class="{ 'smtp-line--latest': i === currentLine && isPlaying }"
            >
              <span class="smtp-prefix smtp-prefix--client">C</span>
              <span class="smtp-text smtp-terminator">{{ line.text }}</span>
              <span v-if="i === currentLine && isPlaying" class="smtp-cursor" />
            </div>

            <!-- Annotation (TLS) -->
            <div
              v-else-if="line.type === 'annotation' && i <= currentLine"
              class="smtp-line smtp-line--annotation"
              :class="{ 'smtp-line--latest': i === currentLine && isPlaying }"
            >
              <div class="smtp-tls-banner">
                <svg class="smtp-tls-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
                <span>{{ line.text }}</span>
              </div>
            </div>

            <!-- Blank line -->
            <div
              v-else-if="line.type === 'blank' && i <= currentLine"
              class="smtp-line smtp-line--blank"
            >
              <span class="smtp-prefix">&nbsp;</span>
            </div>
          </template>
        </div>
      </div>

      <!-- Email preview card that builds during DATA phase -->
      <div
        class="smtp-preview"
        :class="{
          'smtp-preview--visible': emailPreview,
          'smtp-preview--queued': emailPreview?.queued,
        }"
      >
        <div class="smtp-preview-chrome">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
            <polyline points="22,6 12,13 2,6" />
          </svg>
          <span>Received message</span>
          <span v-if="emailPreview?.queued" class="smtp-preview-badge">Delivered</span>
        </div>
        <div class="smtp-preview-body">
          <div v-if="emailPreview?.from" class="smtp-preview-field">
            <span class="smtp-preview-label">From</span>
            <span class="smtp-preview-value">{{ emailPreview.from }}</span>
          </div>
          <div v-if="emailPreview?.to" class="smtp-preview-field">
            <span class="smtp-preview-label">To</span>
            <span class="smtp-preview-value">{{ emailPreview.to }}</span>
          </div>
          <div v-if="emailPreview?.subject" class="smtp-preview-field smtp-preview-field--subject">
            <span class="smtp-preview-label">Subject</span>
            <span class="smtp-preview-value smtp-preview-subject">{{ emailPreview.subject }}</span>
          </div>
          <div v-if="emailPreview?.body" class="smtp-preview-content">
            {{ emailPreview.body }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.smtp {
  margin: 2rem 0;
  opacity: 0;
  transform: translateY(12px);
  transition: opacity 0.6s var(--ease-spring), transform 0.6s var(--ease-spring);
}

.smtp.is-visible {
  opacity: 1;
  transform: translateY(0);
}

/* ── Phase progress bar ── */
.smtp-phases {
  display: flex;
  align-items: center;
  gap: 0;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.smtp-phase {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-family: var(--font-mono);
  font-weight: var(--font-weight-medium);
  letter-spacing: 0.02em;
  color: var(--color-text-disabled);
  transition: all var(--motion-slow) var(--ease-spring);
}

.smtp-phase-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--color-bg-surface);
  border: 1.5px solid var(--color-border-subtle);
  transition: all var(--motion-slow) var(--ease-spring);
}

.smtp-phase-icon svg {
  opacity: 0.4;
  transition: opacity var(--motion-moderate);
}

.smtp-phase--reached .smtp-phase-icon {
  border-color: var(--color-border-default);
}

.smtp-phase--reached .smtp-phase-icon svg {
  opacity: 0.7;
}

.smtp-phase--active .smtp-phase-icon svg { opacity: 1; }

.smtp-phase--active.smtp-phase--brand .smtp-phase-icon { background: color-mix(in oklab, var(--color-brand) 15%, var(--color-bg-surface)); border-color: var(--color-brand); color: var(--color-brand); box-shadow: 0 0 10px color-mix(in oklab, var(--color-brand) 20%, transparent); }
.smtp-phase--active.smtp-phase--warning .smtp-phase-icon { background: color-mix(in oklab, var(--color-warning) 15%, var(--color-bg-surface)); border-color: var(--color-warning); color: var(--color-warning); box-shadow: 0 0 10px color-mix(in oklab, var(--color-warning) 20%, transparent); }
.smtp-phase--active.smtp-phase--info .smtp-phase-icon { background: color-mix(in oklab, var(--color-info) 15%, var(--color-bg-surface)); border-color: var(--color-info); color: var(--color-info); box-shadow: 0 0 10px color-mix(in oklab, var(--color-info) 20%, transparent); }
.smtp-phase--active.smtp-phase--accent .smtp-phase-icon { background: color-mix(in oklab, var(--color-accent) 15%, var(--color-bg-surface)); border-color: var(--color-accent); color: var(--color-accent); box-shadow: 0 0 10px color-mix(in oklab, var(--color-accent) 20%, transparent); }
.smtp-phase--active.smtp-phase--success .smtp-phase-icon { background: color-mix(in oklab, var(--color-success) 15%, var(--color-bg-surface)); border-color: var(--color-success); color: var(--color-success); box-shadow: 0 0 10px color-mix(in oklab, var(--color-success) 20%, transparent); }

.smtp-phase--active { color: var(--color-text-primary); }
.smtp-phase--reached:not(.smtp-phase--active) { color: var(--color-text-tertiary); }

.smtp-phase-label {
  line-height: 1;
}

/* Hide labels on small screens */
@media (max-width: 540px) {
  .smtp-phase-label { display: none; }
}

.smtp-phase-connector {
  width: 16px;
  height: 1.5px;
  background: var(--color-border-subtle);
  flex-shrink: 0;
  transition: background var(--motion-slow) var(--ease-spring);
}

.smtp-phase-connector--active {
  background: var(--color-border-default);
}

/* ── Layout: terminal + preview side-by-side ── */
.smtp-layout {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

@media (max-width: 700px) {
  .smtp-layout {
    flex-direction: column;
  }
}

/* ── Terminal window ── */
.smtp-terminal {
  flex: 1;
  min-width: 0;
  border-radius: 10px;
  overflow: hidden;
  background: var(--color-bg-deep);
  border: 1px solid var(--color-border-subtle);
}

.smtp-chrome {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  background: var(--color-bg-surface);
  border-bottom: 1px solid var(--color-border-subtle);
}

.smtp-dots {
  display: flex;
  gap: 5px;
}

.smtp-dots span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-border-default);
  opacity: 0.5;
}

.smtp-title {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 0.6875rem;
  font-family: var(--font-mono);
  color: var(--color-text-tertiary);
}

.smtp-lock {
  color: var(--color-success);
  animation: smtp-lock-in 0.4s var(--ease-spring);
}

@keyframes smtp-lock-in {
  from { opacity: 0; transform: scale(0.5); }
  to { opacity: 1; transform: scale(1); }
}

.smtp-controls {
  display: flex;
  gap: 4px;
  min-width: 28px;
}

.smtp-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  transition: background var(--motion-moderate), color var(--motion-moderate);
}

.smtp-btn:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
}

/* ── Terminal body — FIXED HEIGHT to prevent layout shift ── */
.smtp-body {
  padding: 12px 16px;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.75;
  /* 27 visible lines × 1.75 line-height × 0.75rem ≈ reserving space for all lines + separators */
  height: calc(31 * 1.75em + 24px);
  overflow-y: auto;
  overflow-x: hidden;
}

/* ── Lines ── */
.smtp-line {
  display: flex;
  align-items: baseline;
  white-space: nowrap;
}

.smtp-line--latest {
  animation: smtp-line-in 0.18s ease-out;
}

@keyframes smtp-line-in {
  from { opacity: 0; transform: translateX(-6px); }
  to { opacity: 1; transform: translateX(0); }
}

/* ── Phase separator ── */
.smtp-sep {
  height: 1px;
  margin: 6px 0;
  background: var(--color-border-subtle);
  opacity: 0.5;
  animation: smtp-sep-in 0.3s ease-out;
}

@keyframes smtp-sep-in {
  from { opacity: 0; transform: scaleX(0); }
  to { opacity: 0.5; transform: scaleX(1); }
}

/* ── Prefix (S / C) ── */
.smtp-prefix {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  font-weight: 700;
  font-size: 0.625rem;
  border-radius: 4px;
  margin-right: 8px;
  user-select: none;
  line-height: 1;
  position: relative;
  top: 1px;
}

.smtp-prefix--server {
  background: color-mix(in oklab, var(--color-info) 12%, var(--color-bg-deep));
  color: var(--color-info);
  border: 1px solid color-mix(in oklab, var(--color-info) 20%, transparent);
}

.smtp-prefix--client {
  background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-deep));
  color: var(--color-brand);
  border: 1px solid color-mix(in oklab, var(--color-brand) 20%, transparent);
}

/* ── Server text: status code highlighted ── */
.smtp-code {
  font-weight: 700;
}

.smtp-code--server {
  color: var(--color-info);
}

.smtp-rest--server {
  color: color-mix(in oklab, var(--color-info) 50%, var(--color-text-tertiary));
}

/* ── Client command text ── */
.smtp-keyword {
  font-weight: 700;
  color: var(--color-brand);
}

.smtp-args {
  color: var(--color-text-secondary);
}

/* ── Header lines (From:, To:, Subject:, Date:) ── */
.smtp-line--header {
  padding-left: 4px;
  border-left: 2px solid color-mix(in oklab, var(--color-accent) 30%, transparent);
  margin-left: 0;
}

.smtp-header-key {
  color: var(--color-accent);
  font-weight: var(--font-weight-semibold);
}

.smtp-header-val {
  color: var(--color-text-primary);
}

/* ── Body text ── */
.smtp-line--body {
  padding-left: 4px;
  border-left: 2px solid color-mix(in oklab, var(--color-success) 25%, transparent);
}

.smtp-body-text {
  color: var(--color-text-primary);
  font-family: var(--font-sans);
  font-style: italic;
}

/* ── Terminator (.) ── */
.smtp-terminator {
  color: var(--color-text-disabled);
  font-weight: 700;
}

/* ── TLS annotation banner ── */
.smtp-tls-banner {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  margin: 4px 0;
  border-radius: 6px;
  background: color-mix(in oklab, var(--color-warning) 8%, var(--color-bg-deep));
  border: 1px solid color-mix(in oklab, var(--color-warning) 20%, transparent);
  color: var(--color-warning);
  font-size: 0.6875rem;
  font-style: italic;
}

.smtp-line--annotation.smtp-line--latest .smtp-tls-banner {
  animation: smtp-tls 1s ease-out;
}

@keyframes smtp-tls {
  0% { opacity: 0; transform: scaleX(0.8); }
  100% { opacity: 1; transform: scaleX(1); }
}

.smtp-tls-icon {
  flex-shrink: 0;
  animation: smtp-tls-lock 0.6s var(--ease-spring) 0.3s both;
}

@keyframes smtp-tls-lock {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ── Blinking cursor ── */
.smtp-cursor {
  display: inline-block;
  width: 6px;
  height: 13px;
  margin-left: 2px;
  background: var(--color-brand);
  border-radius: 1px;
  animation: smtp-blink 0.8s steps(2) infinite;
  vertical-align: text-bottom;
}

@keyframes smtp-blink {
  0% { opacity: 1; }
  50% { opacity: 0; }
}

.smtp-line--cursor {
  height: 1.75em;
}

.smtp-line--blank {
  height: 1.75em;
}

/* ── Email preview card ── */
.smtp-preview {
  width: 220px;
  flex-shrink: 0;
  border-radius: 10px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  overflow: hidden;
  opacity: 0;
  transform: translateX(10px) scale(0.97);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring), border-color var(--motion-slow);
  pointer-events: none;
}

.smtp-preview--visible {
  opacity: 1;
  transform: translateX(0) scale(1);
  pointer-events: auto;
}

.smtp-preview--queued {
  border-color: color-mix(in oklab, var(--color-success) 35%, var(--color-border-subtle));
}

@media (max-width: 700px) {
  .smtp-preview {
    width: 100%;
  }
}

.smtp-preview-chrome {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: 0.6875rem;
  font-weight: var(--font-weight-medium);
  color: var(--color-text-tertiary);
}

.smtp-preview-badge {
  margin-left: auto;
  padding: 1px 7px;
  border-radius: 9999px;
  font-size: 0.5625rem;
  font-weight: var(--font-weight-semibold);
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: color-mix(in oklab, var(--color-success) 12%, var(--color-bg-surface));
  color: var(--color-success);
  animation: smtp-badge-in 0.4s var(--ease-spring);
}

@keyframes smtp-badge-in {
  from { opacity: 0; transform: scale(0.8); }
  to { opacity: 1; transform: scale(1); }
}

.smtp-preview-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.smtp-preview-field {
  display: flex;
  flex-direction: column;
  gap: 1px;
  animation: smtp-field-in 0.3s ease-out;
}

@keyframes smtp-field-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.smtp-preview-label {
  font-size: 0.5625rem;
  font-family: var(--font-mono);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-disabled);
}

.smtp-preview-value {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.smtp-preview-field--subject {
  padding-bottom: 6px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.smtp-preview-subject {
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.smtp-preview-content {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
  font-style: italic;
  animation: smtp-field-in 0.3s ease-out;
}
</style>
