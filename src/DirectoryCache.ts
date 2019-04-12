import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import mkdirp = require('mkdirp-promise');
import * as fs from 'fs';
import NodeCache = require('node-cache');
import rmfr = require( 'rmfr' );
import { encode as msgpackEncode, decode as msgpackDecode } from "msgpack-lite";
import { ServerInfo } from './Connection';

enum WorkerFileType {
    FILE      = 0x01,
    DIRECTORY = 0x02,
    SYMLINK   = 0x10,
}

interface CachedFile {
    length: number;
    iv: Buffer;
    content?: Buffer;
}

export class DirectoryCache {

    private statCache: NodeCache;
    private listCache: NodeCache;

    private unsafePathChars: RegExp = /[\/\\\:\*\?\"\<\>\|\~]/g;
    private fileCacheBase: string;
    private serverInfo?: ServerInfo;
    private fileCacheKey?: Buffer;

    constructor( fileCacheBase: string ) {
        this.fileCacheBase = fileCacheBase;

        this.statCache = new NodeCache( {
            stdTTL: 10,
            checkperiod: 120,
        } );

        this.listCache = new NodeCache( {
            stdTTL: 10,
            checkperiod: 120,
        } );
    }

    public async setServerInfo( serverInfo: ServerInfo ) {
        if ( serverInfo.newCacheKey ) {
            await rmfr( path.join( this.fileCacheBase, 'files' ) );
        }

        this.serverInfo = serverInfo;
        this.fileCacheKey = Buffer.from( serverInfo.cacheKey, 'hex' );
    }

    public normalizePath( path: string ): string {
        return path.split( '/' ).filter( x => x ).join( '/' );
    }

    public getStat( statPath: string ): vscode.FileStat | undefined {
        return this.statCache.get( this.normalizePath( statPath ) );
    }

    public setStat( statPath: string, stat: vscode.FileStat ) {
        this.statCache.set( this.normalizePath( statPath ), stat );
    }

    public clearStat( statPath: string ) {
        this.statCache.del( this.normalizePath( statPath ) );
    }

    public getListing( basePath: string ): [string, vscode.FileType][] | undefined {
        return this.listCache.get( this.normalizePath( basePath ) );
    }

    public setListing( basePath: string, rawListing: { [ name: string ]: number[] } ) {
        const listing: [string, vscode.FileType][] = [];
        for ( const name in rawListing ) {
            const stat = this.parseStat( rawListing[ name ] );
            listing.push( [ name, stat.type ] );
            this.setStat( path.posix.join( basePath, name ), stat );
        }

        this.listCache.set( this.normalizePath( basePath ), listing );
    }

    public clearListing( basePath: string ) {
        this.listCache.del( this.normalizePath( basePath ) );
    }

    public parseStat( rawStat: number[] ): vscode.FileStat {
        return {
            type: this.workerFileTypeToVscode( rawStat[0] ),
            ctime: rawStat[1],
            mtime: rawStat[2],
            size: rawStat[3]
        };
    }

    async setFile( remotePath: string, content: Uint8Array ) {
        if ( ! this.fileCacheKey ) {
            return;
        }

        try {
            const storagePath = this.fileCachePath( remotePath );
            await mkdirp( path.dirname( storagePath ) );

            const iv = crypto.randomBytes( 16 );
            const header = msgpackEncode( [ content.length, iv ] );

            const cipher = crypto.createCipheriv( 'aes-256-cbc', this.fileCacheKey, iv );

            const fh = fs.createWriteStream( storagePath, { mode: 0o600 } );
            const writePromise = new Promise ( ( resolve, reject ) => {
                fh.on( 'error', reject );
                fh.on( 'close', resolve );
            } );

            // 1 byte header size
            const headerSizeBuffer = Buffer.alloc( 1 );
            headerSizeBuffer.writeUInt8( header.length, 0 );
            fh.write( headerSizeBuffer );

            // Header
            fh.write( header );

            // Encrypted content
            fh.write( cipher.update( content ) );
            fh.write( cipher.final() );

            await writePromise;
        } catch ( err ) {
            vscode.window.showWarningMessage( 'Failed to cache file ' + remotePath + ': ' + err.message, { modal: false } );
        }
    }

    public async getFile( remotePath: string, readContents: boolean ): Promise<CachedFile | undefined> {
        if ( ! this.fileCacheKey ) {
            return undefined;
        }

        try {
            const storagePath = this.fileCachePath( remotePath );

            // TODO: Replace with fs.promise when the API stabilizes
            const fd = await new Promise<number>( ( resolve, reject ) => {
                fs.open( storagePath, 'r', ( err: Error, fd: number ) => {
                    if ( err ) {
                        reject( err );
                    } else {
                        resolve( fd );
                    }
                } );
            } );

            const readBytes = async ( size: number ): Promise<Buffer> => {
                return new Promise<Buffer>( ( resolve, reject ) => {
                    const buffer = Buffer.alloc( size );
                    fs.read( fd, buffer, 0, size, null, ( err, bytesRead ) => {
                        if ( err ) {
                            reject( err );
                        } else {
                            resolve( buffer.slice( 0, bytesRead ) );
                        }
                    } );
                } );
            };

            // Read header
            const headerSize = ( await readBytes( 1 ) ).readInt8( 0 );
            const header = await readBytes( headerSize );
            const [ length, iv ] = msgpackDecode( header );
            const cachedFile: CachedFile = { length, iv };

            // Stop here if not reading the body.
            if ( ! readContents ) {
                return cachedFile;
            }

            // Prepare a decipher and a target buffer for decryption
            const decipher = crypto.createDecipheriv( 'aes-256-cbc', this.fileCacheKey, iv );
            const decrypted = Buffer.alloc( cachedFile.length );
            let decryptedCursor = 0;
        
            // Stream remainder of file through decipher
            await new Promise( ( resolve, reject ) => {
                const stream = fs.createReadStream( remotePath, { fd } );
                stream.on( 'error', reject );

                stream.on( 'data', ( chunk ) => {
                    const decryptedChunk = decipher.update( chunk );
                    decryptedChunk.copy( decrypted, decryptedCursor );
                    decryptedCursor += decryptedChunk.length;
                } );

                stream.on( 'end', () => {
                    const finalChunk = decipher.final();
                    finalChunk.copy( decrypted, decryptedCursor );
                    if ( decryptedCursor + finalChunk.length !== cachedFile.length ) {
                        reject( new Error( 'Cached file content length did not match header' ) );
                    } else {
                        resolve( decrypted );
                    }
                } );
            } );

            cachedFile.content = decrypted;
            return cachedFile;
        } catch ( err ) {
            // Ignore ENOENT errors; they just mean the file is not cached. :)
            if ( err.code !== 'ENOENT' ) {
                console.warn( 'Error while reading cached file: ', err );
            }
            return undefined;
        }
    }

    public touchFile( remotePath: string ) {
        const storagePath = this.fileCachePath( remotePath );
        const now = new Date();
        fs.utimes( storagePath, now, now, ( err ) => {
            if ( err ) {
                console.warn( 'Failed to bump mtime on ' + storagePath, err );
            }
        } );
    }

    private workerFileTypeToVscode( workerFileType: WorkerFileType ): vscode.FileType {
        let type: vscode.FileType = vscode.FileType.Unknown;

        if ( workerFileType & WorkerFileType.FILE ) {
            type = vscode.FileType.File;
        } else if ( workerFileType & WorkerFileType.DIRECTORY ) {
            type = vscode.FileType.Directory;
        }

        if ( workerFileType & WorkerFileType.SYMLINK ) {
            type += vscode.FileType.SymbolicLink;
        }

        return type;
    }

    // Given a filename, keep it unique, free from special chars and length-limited for use in cache path
    private stripPathPiece( pathPiece: string ): string {
        const clean = pathPiece.replace( this.unsafePathChars, '-' ).substr( 0, 100 );
        if ( clean === pathPiece ) {
            return pathPiece;
        } else {
            return clean + '-' + crypto.createHash( 'md5' ).update( pathPiece ).digest( 'hex' );
        }
    }

    // Strip a remote path to make it friendly to store on most local filesystems
    private fileCachePath( remotePath: string ): string {
        // Always try to expand ~ to full home path for cache pathing.
        if ( this.serverInfo && remotePath.startsWith( '~/' ) ) {
            remotePath = this.serverInfo.home + remotePath.slice( 2 );
        }

        const pieces = remotePath.split( '/' ).filter( x => x ).map( this.stripPathPiece.bind( this ) );
        return path.join( this.fileCacheBase, 'files', ...pieces );
    }

}
