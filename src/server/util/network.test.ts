import { describe, expect, it } from 'vitest';
import { isPrivateAddress, privateHostReason } from './network.js';

describe('isPrivateAddress', () => {
  it('rejects loopback', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('127.255.255.254')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
  });

  it('rejects the link-local range that holds cloud metadata', () => {
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('febf::1')).toBe(true);
  });

  it('rejects the private ranges', () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('172.31.255.255')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
  });

  it('rejects carrier NAT, multicast, reserved and "this host"', () => {
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('224.0.0.1')).toBe(true);
    expect(isPrivateAddress('255.255.255.255')).toBe(true);
    expect(isPrivateAddress('0.0.0.0')).toBe(true);
  });

  it('sees through an IPv4-mapped IPv6 address', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::ffff:93.184.216.34')).toBe(false);
  });

  it('ignores a zone id', () => {
    expect(isPrivateAddress('fe80::1%eth0')).toBe(true);
  });

  it('allows ordinary public addresses', () => {
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
    expect(isPrivateAddress('2606:2800:220:1::248')).toBe(false);
  });

  it('treats anything unclassifiable as private', () => {
    expect(isPrivateAddress('not-an-address')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });
});

// Numeric hosts are resolved without touching the network, so these stay hermetic.
describe('privateHostReason', () => {
  it('blocks the bot reaching its own dashboard', async () => {
    await expect(privateHostReason('http://127.0.0.1:3000/api/status')).resolves.toMatch(
      /private or local network/,
    );
  });

  it('blocks the cloud metadata address', async () => {
    await expect(privateHostReason('http://169.254.169.254/latest/meta-data/')).resolves.toMatch(
      /private or local network/,
    );
  });

  it('blocks a bracketed IPv6 loopback', async () => {
    await expect(privateHostReason('http://[::1]:3000/')).resolves.toMatch(
      /private or local network/,
    );
  });

  it('allows a public address', async () => {
    await expect(privateHostReason('https://93.184.216.34/clip.mp4')).resolves.toBeNull();
  });

  it('complains about input that is not a URL', async () => {
    await expect(privateHostReason('not a url')).resolves.toBe('That does not look like a URL.');
  });
});
