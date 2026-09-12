const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function activate(context) {
    const decorationProvider = new Gat9SymlinksDecorationProvider();
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));


    // Команда 1: gat9 Link (Перенос файла в хранилище и создание симлинка)
    let linkCommand = vscode.commands.registerCommand('gat9.link', async (uri) => {
        if (!uri) return;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        const workspaceRoot = workspaceFolder.uri.fsPath;

        if (!workspaceRoot) {
            vscode.window.showErrorMessage('Откройте папку в VS Code перед использованием gat9-symlinks.');
            return;
        }

        const config = getConfigForFolder(workspaceRoot);
        if (!config) {
            vscode.window.showErrorMessage('Конфигурация gat9-symlinks не найдена (или отключена через ключ disabled/ignore).');
            return;
        }

        const storeDir = config.storePath;

        if (!fs.existsSync(storeDir)) {
            fs.mkdirSync(storeDir, { recursive: true });
        }

        const originalPath = uri.fsPath;
        const stats = fs.lstatSync(originalPath);

        if (stats.isSymbolicLink()) {
            vscode.window.showWarningMessage('Этот элемент уже является ссылкой.');
            return;
        }

        const isDirectory = stats.isDirectory();
        const itemName = path.basename(originalPath);

        // Генерируем уникальное имя для хранилища
        let uniqueStoreName = itemName;
        if (!isDirectory) {
            // Для файлов используем хэш контента (как было)
            const fileBuffer = fs.readFileSync(originalPath);
            const hash = crypto.createHash('md5').update(fileBuffer).digest('hex').substring(0, 8);
            const fileExt = path.extname(itemName);
            const fileBase = path.basename(itemName, fileExt);
            uniqueStoreName = `${fileBase}_${hash}${fileExt}`;
        } else {
            // Для папок используем хэш от абсолютного пути, чтобы не путать одинаковые папки (н-р, "config") из разных проектов
            const pathHash = crypto.createHash('md5').update(originalPath).digest('hex').substring(0, 6);
            uniqueStoreName = `${itemName}_dir_${pathHash}`;
        }

        const targetStorePath = path.join(storeDir, uniqueStoreName);

        try {
            if (!fs.existsSync(targetStorePath)) {
                if (isDirectory) {
                    // Для копирования папок целиком в Node.js используется cpSync (с версии 16.7+)
                    fs.cpSync(originalPath, targetStorePath, { recursive: true });
                } else {
                    fs.copyFileSync(originalPath, targetStorePath);
                }
            }

            // Удаляем оригинал в корзину (работает и для файлов, и для папок)
            await vscode.workspace.fs.delete(uri, { useTrash: true, recursive: true });

            // Создаем симлинк. В Windows для папок НАДЕЖНЕЕ ВСЕГО использовать тип 'junction'
            // Он не требует прав администратора даже без режима разработчика и стабильно работает в VS Code
            const linkType = isDirectory ? 'junction' : 'file';
            fs.symlinkSync(targetStorePath, originalPath, linkType);

            vscode.window.showInformationMessage(`Папка/файл успешно перенесены в gat9-symlinks Store.`);
        } catch (err) {
            vscode.window.showErrorMessage(`Ошибка линковки: ${err.message}`);
        }
        // Добавьте эту строчку в конец успешного выполнения gat9.link и gat9.restore:
        decorationProvider.refresh();

    });

    // Команда 2: gat9 Restore (Обратный процесс)
    let restoreCommand = vscode.commands.registerCommand('gat9.restore', async (uri) => {
        if (!uri) return;
        const filePath = uri.fsPath;
        const fileStats = fs.lstatSync(filePath);

        if (!fileStats.isSymbolicLink() && !fileStats.isDirectory()) {
            // Junction-точки Windows Node.js иногда определяет как Directory, но fs.readlinkSync на них работает
            // Поэтому делаем дополнительную проверку через try-catch ниже
        }

        try {
            const targetStorePath = fs.readlinkSync(filePath);

            if (!fs.existsSync(targetStorePath)) {
                vscode.window.showErrorMessage('Исходный объект в хранилище не найден.');
                return;
            }

            const storeStats = fs.statSync(targetStorePath);
            const isDirectory = storeStats.isDirectory();
            const enableBackups = vscode.workspace.getConfiguration('gat9').get('enableBackups');

            // Удаляем ссылку. В Windows для junction-папок используется fs.rmdirSync, для файлов fs.unlinkSync
            if (isDirectory) {
                fs.rmdirSync(filePath);
            } else {
                fs.unlinkSync(filePath);
            }

            // Возвращаем объект обратно
            if (isDirectory) {
                fs.cpSync(targetStorePath, filePath, { recursive: true });
            } else {
                fs.copyFileSync(targetStorePath, filePath);
            }

            if (!enableBackups) {
                const storeUri = vscode.Uri.file(targetStorePath);
                await vscode.workspace.fs.delete(storeUri, { useTrash: true, recursive: true });
            }

            vscode.window.showInformationMessage('Объект успешно восстановлен, ссылка удалена.');
        } catch (err) {
            vscode.window.showErrorMessage(`Этот объект не является ссылкой gat9-symlinks или произошла ошибка: ${err.message}`);
        }
        // Добавьте эту строчку в конец успешного выполнения gat9.link и gat9.restore:
        decorationProvider.refresh();

    });

    context.subscriptions.push(linkCommand, restoreCommand);
}

function getConfigForFolder(workspaceRoot) {
    const os = require('os');
    const localConfigPath = path.join(workspaceRoot, '.gat9-symlinks');
    let configPath = null;
    let isLocal = false;

    // 1. Проверяем локальный конфиг
    if (fs.existsSync(localConfigPath)) {
        configPath = localConfigPath;
        isLocal = true;
    } else {
        // 2. Если локального нет, берем глобальный путь из настроек VS Code
        let globalSettingPath = vscode.workspace.getConfiguration('gat9-symlinks').get('globalConfigPath') || '~/.gat9-symlinks';

        // Разворачиваем тильду (~) в домашнюю директорию пользователя
        if (globalSettingPath.startsWith('~')) {
            globalSettingPath = path.join(os.homedir(), globalSettingPath.slice(1));
        }

        const absoluteGlobalPath = path.resolve(globalSettingPath);
        if (fs.existsSync(absoluteGlobalPath)) {
            configPath = absoluteGlobalPath;
        }
    }

    if (!configPath) return null;

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        // Штрих №1: Проверяем ключ игнорирования (отключения)
        // Например: "disabled": true или "ignore": true
        if (config.disabled === true || config.ignore === true) {
            return null;
        }

        // Проверяем, что внутри есть путь к хранилищу
        if (!config.storePath) return null;

        return {
            storePath: config.storePath,
            isLocal: isLocal
        };
    } catch (e) {
        // Если JSON битый, молча игнорируем или пишем в консоль
        console.error(`[gat9] Ошибка парсинга конфига ${configPath}: ${e.message}`);
        return null;
    }
}

class Gat9SymlinksDecorationProvider {
    constructor() {
        this._onDidChangeFileDecorations = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
    }

    refresh() {
        this._onDidChangeFileDecorations.fire(undefined);
    }

    provideFileDecoration(uri) {
        try {
            const fsPath = uri.fsPath;
            if (!fs.existsSync(fsPath)) return null;

            // Получаем все открытые папки в текущем окне VS Code
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) return null;

            // Перебираем открытые папки, чтобы найти .gat9 и storePath
            for (const folder of workspaceFolders) {
                const workspaceRoot = folder.uri.fsPath;

                const config = getConfigForFolder(workspaceRoot);
                if (!config) {
                    vscode.window.showErrorMessage('Конфигурация gat9-symlinks не найдена (или отключена через ключ disabled/ignore).');
                    return;
                }

                if (!config.storePath) continue;

                // Строго нормализуем пути для Windows (убираем разницу в слэшах и регистре)
                const storeDir = path.resolve(config.storePath).toLowerCase();
                const normalizedFsPath = path.resolve(fsPath).toLowerCase();

                const stats = fs.lstatSync(fsPath);
                let isLink = stats.isSymbolicLink();
                let targetPath = '';

                // 1. ПРОВЕРКА: Это симлинк внутри проекта
                if (!isLink && stats.isDirectory()) {
                    try {
                        targetPath = fs.readlinkSync(fsPath);
                        isLink = true;
                    } catch (e) { }
                } else if (isLink) {
                    targetPath = fs.readlinkSync(fsPath);
                }

                if (isLink && targetPath) {
                    return {
                        badge: "🔗",
                        tooltip: `gat9 Link ➡️ ведет на: ${targetPath}`,
                        propagate: false
                    };
                }

                // 2. ПРОВЕРКА: Это исходный файл внутри Хранилища
                if (normalizedFsPath.startsWith(storeDir)) {
                    const linksPointingHere = [];

                    // Функция рекурсивного поиска ссылок в текущем проекте
                    const findLinks = (dir) => {
                        try {
                            const files = fs.readdirSync(dir);
                            for (const file of files) {
                                if (file === '.git' || file === 'node_modules') continue;

                                const fullPath = path.join(dir, file);
                                try {
                                    const lstats = fs.lstatSync(fullPath);
                                    let currentTarget = '';

                                    if (lstats.isSymbolicLink()) {
                                        currentTarget = fs.readlinkSync(fullPath);
                                    } else if (lstats.isDirectory()) {
                                        try {
                                            currentTarget = fs.readlinkSync(fullPath);
                                        } catch (e) {
                                            findLinks(fullPath); // Обычная папка — идем глубже
                                        }
                                    }

                                    if (currentTarget) {
                                        const normTarget = path.resolve(currentTarget).toLowerCase();
                                        if (normTarget === normalizedFsPath) {
                                            linksPointingHere.push(path.relative(workspaceRoot, fullPath));
                                        }
                                    }
                                } catch (e) { }
                            }
                        } catch (e) { }
                    };

                    findLinks(workspaceRoot);

                    if (linksPointingHere.length > 0) {
                        return {
                            badge: "📦",
                            tooltip: `gat9 Исходник 📥 Используется в проекте:\n• ${linksPointingHere.join('\n• ')}`,
                            color: new vscode.ThemeColor("charts.blue"),
                            propagate: false
                        };
                    }
                }
            }

        } catch (err) {
            // Ошибки не ломают интерфейс
        }
        return null;
    }

}

function deactivate() { }

module.exports = { activate, deactivate };

