// Zero-dep interactive prompts: raw-mode readline, arrows + enter

import readline from "readline";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";

let onKeypress = null;

function start() {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", handleKeypress);
  process.stdout.write(HIDE_CURSOR);
}

function stop() {
  process.stdout.write(SHOW_CURSOR);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdin.removeListener("keypress", handleKeypress);
}

function handleKeypress(str, key) {
  if (key?.ctrl && key.name === "c") {
    stop();
    process.stdout.write("\n");
    process.exit(0);
  }
  if (onKeypress) onKeypress(key);
}

function question(message) {
  return `${GREEN}?${RESET} ${message}`;
}

function confirmed(message, value) {
  return `${GREEN}✔${RESET} ${message}: ${value}`;
}

export async function promptSelect({ message, hint, choices, default: def }) {
  let index = Math.max(0, choices.findIndex((choice) => choice.value === def));
  const hintLines = hint ? hint.split("\n").length : 0;
  const lines = choices.length + 1 + hintLines;
  const render = (clear = false) => {
    if (clear) process.stdout.write(`\x1b[${lines}A\r\x1b[J`);
    process.stdout.write(`${question(message)}${hint ? `\n${hint}` : ""}\n`);
    for (let i = 0; i < choices.length; i++) {
      const selected = i === index;
      process.stdout.write(` ${selected ? `${CYAN}❯${RESET}` : " "} ${selected ? `${CYAN}${choices[i].name}${RESET}` : choices[i].name}\n`);
    }
  };

  start();
  render();
  return new Promise((resolve) => {
    onKeypress = (key) => {
      if (key.name === "up") {
        index = (index - 1 + choices.length) % choices.length;
        render(true);
      } else if (key.name === "down") {
        index = (index + 1) % choices.length;
        render(true);
      } else if (key.name === "return") {
        const choice = choices[index];
        process.stdout.write(`\x1b[${lines}A\r\x1b[J${confirmed(message, choice.name)}\n`);
        stop();
        resolve(choice.value);
      }
    };
  });
}

export async function promptInput({ message, default: def = "" }) {
  let buf = "";
  const render = () => {
    process.stdout.write(`\r\x1b[2K${question(message)}${def ? ` ${DIM}(${def})${RESET}` : ""} ${buf}`);
  };

  start();
  render();
  return new Promise((resolve) => {
    onKeypress = (key) => {
      if (key.name === "return") {
        const value = buf || def;
        process.stdout.write(`\r\x1b[2K${confirmed(message, value)}\n`);
        stop();
        resolve(value);
      } else if (key.name === "backspace") {
        buf = buf.slice(0, -1);
        render();
      } else if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
        buf += key.sequence;
        render();
      }
    };
  });
}

export async function promptNumber({ message, default: def }) {
  for (;;) {
    const raw = await promptInput({ message, default: String(def) });
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    process.stdout.write(`  ${RED}✗ must be a number (1-65535)${RESET}\n`);
  }
}
