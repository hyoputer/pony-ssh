import * as vscode from 'vscode';
import { PonyFileSystem } from './PonyFileSystem';
import { StatusTicker } from './StatusTicker';
import { log } from './Log';

interface ResetHostMenuItem extends vscode.QuickPickItem {
	name?: string;
	all?: boolean;
}

export function activate( context: vscode.ExtensionContext ) {
	const ponyfs = new PonyFileSystem( context );
	const provider = vscode.workspace.registerFileSystemProvider( 'ponyssh', ponyfs, { isCaseSensitive: true });
    context.subscriptions.push( provider );

	StatusTicker.initialize();
	log.loadConfiguration();

	context.subscriptions.push( vscode.workspace.onDidChangeConfiguration( ( event ) => {
		if ( event.affectsConfiguration( 'ponyssh.hosts' ) ) {
			ponyfs.reloadHostConfigs();
		}

		if ( event.affectsConfiguration( 'ponyssh.logging' ) ) {
			log.loadConfiguration();
		}
	} ) );

	context.subscriptions.push( vscode.commands.registerCommand( 'ponyssh.openFolder', async _ => {
		const availableHosts = ponyfs.getAvailableHosts();
		const names = Object.keys( availableHosts );

		// Ask user to pick a host.
		const hostName = await vscode.window.showQuickPick( names, {
			placeHolder: 'Select a configured host',
		} );
		if ( ! hostName ) {
			return;
		}

		// Ask for remote path
		const defaultPath = availableHosts[ hostName ].path || '~';

		// Open the requested path
		const leadingSlashPath = ( defaultPath.startsWith( '/' ) ? '' : '/' ) + defaultPath;
		const fullPath = 'ponyssh:/' + hostName + leadingSlashPath;
		const displayName = hostName + ':' + ( defaultPath.startsWith( '~' ) ? defaultPath : leadingSlashPath );

        log.info('Opening remote folder: ' + fullPath);


        const options: vscode.OpenDialogOptions = {
            canSelectFiles: false,
            canSelectFolders: true,
            defaultUri: vscode.Uri.parse(fullPath),
            canSelectMany: false,
            openLabel: 'Open'
        };

        vscode.window.showOpenDialog(options).then(fileUri => {
            if (fileUri && fileUri[0]) {
                const newFolder = {
                    name: fileUri[0].fsPath,
                    uri: fileUri[0],
                };

                const position = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0;
                vscode.workspace.updateWorkspaceFolders(position, 0, newFolder);
                vscode.commands.executeCommand('workbench.view.explorer');
            }
        });
	} ) );

	context.subscriptions.push( vscode.commands.registerCommand( 'ponyssh.resetConnections', async _ => {
		const activeHosts = ponyfs.getActiveHosts();
		const names = Object.keys( activeHosts );

		// Ask user to pick a host to reset (or all)
		const choices: ResetHostMenuItem[] = [];
		choices.push( { alwaysShow: true, name: 'All', label: 'Reset All Hosts', picked: true, all: true } );
		choices.push( ...( Object.values( activeHosts ).map( ( host ) => {
			return {
				name: host.name,
				label: host.name,
				description: host.config.host
			};
		} ) ) );
		const selection = await vscode.window.showQuickPick( choices, {
			placeHolder: 'Select a host to reset (or all)',
		} );

		if ( selection ) {
			log.info( 'Resetting connection(s): ' + selection.name! );

			const targets = selection.all ? names : [ selection.name! ];
			for ( const target of targets ) {
				ponyfs.resetHostConnection( target );
			}
		}
	} ) );
}
