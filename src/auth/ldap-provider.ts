import ldap from 'ldapjs';
import type { AuthProvider, AuthIdentity } from './types.js';
import logger from '../logger.js';

export interface LdapProviderOptions {
  url: string;
  bindDN: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string;      // e.g., '(uid={{username}})'
  groupSearchBase?: string;
  groupSearchFilter?: string; // e.g., '(member={{dn}})'
}

/**
 * LDAP-based auth provider.
 *
 * Credential format for LDAP: "username:password" base64-encoded
 * (i.e., Basic auth style). The provider:
 *   1. Binds with a service account
 *   2. Searches for the user by the search filter
 *   3. Re-binds as the user to verify password
 *   4. Optionally resolves group memberships
 */
export class LdapAuthProvider implements AuthProvider {
  readonly name = 'ldap';

  constructor(private readonly options: LdapProviderOptions) { }

  async validateCredential(credential: string): Promise<AuthIdentity> {
    // Credential is base64(username:password)
    let username: string;
    let password: string;

    try {
      const decoded = Buffer.from(credential, 'base64').toString('utf-8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx < 0) throw new Error('Invalid format');
      username = decoded.substring(0, colonIdx);
      password = decoded.substring(colonIdx + 1);
    } catch {
      throw new Error(
        'LDAP credential must be base64-encoded "username:password"',
      );
    }

    if (!username || !password) {
      throw new Error('Username and password are required');
    }

    // Step 1: bind with service account
    const serviceClient = await this.createClient();
    try {
      await this.bind(serviceClient, this.options.bindDN, this.options.bindPassword);

      // Step 2: search for the user
      const filter = this.options.searchFilter.replace(/\{\{username\}\}/g, username);
      const entries = await this.search(serviceClient, this.options.searchBase, filter);
      if (entries.length === 0) {
        throw new Error(`User not found: ${username}`);
      }

      const userEntry = entries[0];
      const userDN = userEntry.dn?.toString() || userEntry.objectName?.toString();
      if (!userDN) {
        throw new Error(`Could not determine DN for user: ${username}`);
      }

      // Step 3: verify user password by re-binding
      const userClient = await this.createClient();
      try {
        await this.bind(userClient, userDN, password);
      } catch (err) {
        throw new Error(`Invalid password for user: ${username}`);
      } finally {
        userClient.destroy();
      }

      // Step 4: resolve groups if configured
      let groups: string[] | undefined;
      if (this.options.groupSearchBase && this.options.groupSearchFilter) {
        const groupFilter = this.options.groupSearchFilter.replace(/\{\{dn\}\}/g, userDN);
        const groupEntries = await this.search(
          serviceClient,
          this.options.groupSearchBase,
          groupFilter,
        );
        groups = groupEntries.map(
          (e) => (e as Record<string, any>).cn?.toString() || e.dn?.toString() || '',
        ).filter(Boolean);
      }

      const email = (userEntry as Record<string, any>).mail?.toString();
      const displayName = (userEntry as Record<string, any>).cn?.toString() ||
        (userEntry as Record<string, any>).displayName?.toString();

      const identity: AuthIdentity = {
        userId: username,
        displayName,
        email,
        groups,
      };

      logger.debug(`[LDAP] Validated user: ${username} (DN: ${userDN})`);
      return identity;
    } finally {
      serviceClient.destroy();
    }
  }

  async shutdown(): Promise<void> {
    // No persistent connection pool to clean up (we create per-request)
  }

  private createClient(): Promise<ldap.Client> {
    return new Promise((resolve, reject) => {
      const client = ldap.createClient({
        url: this.options.url,
        timeout: 10000,
        connectTimeout: 10000,
      });
      client.on('error', (err: Error) => {
        logger.error(`[LDAP] Client error: ${err.message}`);
        reject(err);
      });
      client.on('connect', () => resolve(client));
    });
  }

  private bind(client: ldap.Client, dn: string, password: string): Promise<void> {
    return new Promise((resolve, reject) => {
      client.bind(dn, password, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private search(client: ldap.Client, base: string, filter: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const entries: any[] = [];
      client.search(base, { filter, scope: 'sub' }, (err: Error | null, res: any) => {
        if (err) return reject(err);
        res.on('searchEntry', (entry: any) => entries.push(entry.pojo || entry.object || entry));
        res.on('error', (err: Error) => reject(err));
        res.on('end', () => resolve(entries));
      });
    });
  }
}
