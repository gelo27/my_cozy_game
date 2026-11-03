import { useCallback, useState } from 'react';
import { ConsoleLogEntry } from '../components/ConsoleFooter';

const MAX_LOG_ENTRIES = 50;

const timestamp = () => new Date().toTimeString().split(' ')[0];

const INITIAL_LOGS: ConsoleLogEntry[] = [
  {
    id: 'init-1',
    time: timestamp(),
    type: 'info',
    message: 'Rapier physics dynamic pipeline initialized successfully (Wasm 0.11.2).',
  },
  {
    id: 'init-2',
    time: timestamp(),
    type: 'info',
    message: 'Found 24 static environment colliders & 1 dynamic player rigidbody.',
  },
  {
    id: 'init-3',
    time: timestamp(),
    type: 'info',
    message: 'GroundDetector active with 5-ray array (0.55m max distance).',
  },
];

export type AddLog = (type: ConsoleLogEntry['type'], message: string) => void;

/** Rolling buffer of the last console entries shown in ConsoleFooter. */
export function useConsoleLog() {
  const [logs, setLogs] = useState<ConsoleLogEntry[]>(INITIAL_LOGS);

  const addLog = useCallback<AddLog>((type, message) => {
    const id = Math.random().toString(36).substring(2, 9);
    setLogs(prev => [...prev.slice(-(MAX_LOG_ENTRIES - 1)), { id, time: timestamp(), type, message }]);
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  return { logs, addLog, clearLogs };
}
