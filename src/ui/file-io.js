// State Engine — tiny browser file helpers for export / import buttons.

// Saves `data` as a pretty-printed .json file download.
export function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename.endsWith('.json') ? filename : `${filename}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Opens a file picker for a .json file and resolves with { name, data } (the
// parsed contents), or null when nothing is chosen. Rejects on invalid JSON.
export function pickJsonFile() {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            input.remove();
            if (!file) { resolve(null); return; }
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    resolve({ name: file.name, data: JSON.parse(String(reader.result)) });
                } catch (err) {
                    reject(new Error(`"${file.name}" is not valid JSON.`));
                }
            };
            reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
            reader.readAsText(file);
        });
        document.body.appendChild(input);
        input.click();
    });
}
