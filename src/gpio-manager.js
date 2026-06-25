import { GpioButton } from './gpio.js';

/**
 * Verwaltet mehrere GPIO-Taster gleichzeitig – einen pro Playlist, die einen
 * Pin definiert hat. Jeder Taster wirkt als „Weiter"-Trigger für genau seine
 * Playlist (aktivieren, falls nötig, dann nächstes Video). Intern hält der
 * Manager je Pin eine eigene, bereits erprobte GpioButton-Instanz.
 */
export class GpioManager {
  #buttons = new Map(); // pin(number) -> { button: GpioButton, playlist: string }
  #onPress;

  /** @param {(playlist: string) => void} onPress Rückruf beim Tastendruck */
  constructor(onPress) {
    this.#onPress = onPress;
  }

  /**
   * Pin→Playlist-Zuordnung mit dem gewünschten Stand abgleichen: entfernte
   * Pins stoppen, neue starten, Zuordnung/Entprellung der bestehenden
   * aktualisieren (ohne den laufenden gpiomon-Prozess unnötig neu zu starten).
   *
   * @param {Array<{pin: number, playlist: string}>} bindings
   * @param {number} debounceMs
   */
  apply(bindings, debounceMs) {
    const wanted = new Map(); // pin -> playlist
    for (const { pin, playlist } of bindings) {
      if (Number.isInteger(pin)) wanted.set(pin, playlist);
    }

    // Nicht mehr gewünschte Pins abschalten
    for (const [pin, entry] of this.#buttons) {
      if (!wanted.has(pin)) {
        entry.button.stop();
        this.#buttons.delete(pin);
      }
    }

    // Gewünschte Pins anlegen bzw. aktualisieren
    for (const [pin, playlist] of wanted) {
      let entry = this.#buttons.get(pin);
      if (!entry) {
        const button = new GpioButton();
        entry = { button, playlist };
        this.#buttons.set(pin, entry);
        // Den Pin als festen Schlüssel verwenden – die Playlist liest der
        // Handler stets aktuell aus der Map (Umbenennen ändert nur den Wert).
        button.on('press', () => {
          const current = this.#buttons.get(pin);
          if (current) this.#onPress(current.playlist);
        });
      } else {
        entry.playlist = playlist;
      }
      // configure setzt die Entprellung auch bei gleichem Pin neu und startet
      // gpiomon nur, wenn sich der Pin tatsächlich geändert hat.
      entry.button.configure(pin, debounceMs);
    }
  }

  /** @returns {Array<{pin, playlist, running, error, last_press}>} */
  getStatus() {
    return [...this.#buttons.entries()]
      .map(([pin, entry]) => ({ pin, playlist: entry.playlist, ...entry.button.getStatus() }))
      .sort((a, b) => a.pin - b.pin);
  }

  stop() {
    for (const entry of this.#buttons.values()) entry.button.stop();
    this.#buttons.clear();
  }
}
