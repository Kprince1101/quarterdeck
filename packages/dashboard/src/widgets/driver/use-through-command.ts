import { useState, type ChangeEvent } from 'react';
import { valueOf } from '../../grid/dom.js';
import { parseThrough } from './driver-turns.js';

export interface ThroughCommandView {
  text: string;
  through: number | null;
  handleChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

export const useThroughCommand = (last: number): ThroughCommandView => {
  const [text, setText] = useState(String(last));
  return {
    text,
    through: parseThrough(text, last),
    handleChange: (event) => {
      setText(valueOf(event.currentTarget));
    },
  };
};
