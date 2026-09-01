import { Github, Home, Pause, Play, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { App, sessionIdFromPath } from './App'
import {
  clearShowcaseReplayLimits,
  setShowcaseReplayLimit,
  showcaseReplayCheckpoints,
} from './showcase-api'
import {
  SHOWCASE_NAVIGATION_EVENT,
  SHOWCASE_REPLAY_EVENT,
} from './showcase-mode'
import './showcase.css'

const GITHUB_URL = 'https://github.com/Champ-X/Anera'

export function StaticDemoFrame() {
  const [sessionId, setSessionId] = useState(() => sessionIdFromPath(window.location.pathname))
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const stopTimer = () => {
    window.clearInterval(timer.current)
    timer.current = undefined
    setPlaying(false)
  }

  const showFullTrace = () => {
    stopTimer()
    if (sessionId) setShowcaseReplayLimit(sessionId, null)
    setProgress(null)
    window.dispatchEvent(new Event(SHOWCASE_REPLAY_EVENT))
  }

  const play = () => {
    const activeSessionId = sessionIdFromPath(window.location.pathname)
    if (!activeSessionId) return
    const checkpoints = showcaseReplayCheckpoints(activeSessionId)
    if (checkpoints.length === 0) return
    stopTimer()
    setSessionId(activeSessionId)
    let index = 0
    setShowcaseReplayLimit(activeSessionId, checkpoints[index])
    setProgress({ current: 1, total: checkpoints.length })
    setPlaying(true)
    window.dispatchEvent(new Event(SHOWCASE_REPLAY_EVENT))
    timer.current = window.setInterval(() => {
      index += 1
      if (index >= checkpoints.length) {
        stopTimer()
        setProgress({ current: checkpoints.length, total: checkpoints.length })
        return
      }
      setShowcaseReplayLimit(activeSessionId, checkpoints[index])
      setProgress({ current: index + 1, total: checkpoints.length })
      window.dispatchEvent(new Event(SHOWCASE_REPLAY_EVENT))
    }, 520)
  }

  useEffect(() => {
    const onNavigate = () => {
      stopTimer()
      clearShowcaseReplayLimits()
      setProgress(null)
      setSessionId(sessionIdFromPath(window.location.pathname))
      window.dispatchEvent(new Event(SHOWCASE_REPLAY_EVENT))
    }
    window.addEventListener(SHOWCASE_NAVIGATION_EVENT, onNavigate)
    window.addEventListener('popstate', onNavigate)
    return () => {
      stopTimer()
      window.removeEventListener(SHOWCASE_NAVIGATION_EVENT, onNavigate)
      window.removeEventListener('popstate', onNavigate)
    }
  }, [])

  return <div className="static-demo-frame">
    <header className="static-demo-toolbar">
      <div className="demo-toolbar-context"><span className="live-marker" /><strong>Static replay</strong><span>真实运行快照 · 只读</span></div>
      {sessionId && <div className="demo-replay-controls">
        <button onClick={playing ? stopTimer : play}>{playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}{playing ? '暂停' : progress ? '重新播放' : '播放过程'}</button>
        {progress && <span className="replay-progress" aria-label={`Replay step ${progress.current} of ${progress.total}`}><i style={{ width: `${(progress.current / progress.total) * 100}%` }} /></span>}
        {progress && <button className="icon-control" aria-label="Show full trace" title="显示完整轨迹" onClick={showFullTrace}><RotateCcw size={13} /></button>}
      </div>}
      <nav aria-label="Exhibit"><a href="/"><Home size={13} /> 首页</a><a href="/report">复刻报告</a><a href={GITHUB_URL} target="_blank" rel="noreferrer"><Github size={14} /> <span>GitHub</span></a></nav>
    </header>
    <div className="static-demo-body"><App /></div>
  </div>
}
