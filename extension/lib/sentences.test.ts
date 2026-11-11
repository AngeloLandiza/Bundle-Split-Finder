import { describe, expect, it } from 'vitest';
import { NETWORK_ERROR_PREFIX } from '@core/serpapi/client';
import { sentenceFor } from './sentences';

describe('sentenceFor', () => {
  const network = `${NETWORK_ERROR_PREFIX}: the account check got no answer.`;

  it('says the offline sentence with the closing words the screen has', () => {
    expect(sentenceFor(network)).toBe('SerpApi could not be reached. Check the connection, then retry.');
    expect(sentenceFor(network, 'try again')).toBe('SerpApi could not be reached. Check the connection, then try again.');
  });

  it('says an HTTP error in words and passes SerpApi sentences and empties through', () => {
    expect(sentenceFor('SerpApi returned HTTP 503.')).toBe('SerpApi answered with an error (HTTP 503). Try again later.');
    expect(sentenceFor('SerpApi did not accept this key.', 'try again')).toBe('SerpApi did not accept this key.');
    expect(sentenceFor('')).toBeNull();
    expect(sentenceFor(null)).toBeNull();
    expect(sentenceFor(undefined)).toBeNull();
  });

  it('maps SerpApi texts inside a longer message (Ruling 49)', () => {
    expect(sentenceFor('The lookup of PCL526B failed: SerpApi returned HTTP 404.', 'try again')).toBe(
      'The lookup of PCL526B failed: SerpApi answered with an error (HTTP 404).',
    );
    expect(sentenceFor('A Home Depot page could not be read. The lookup of PCL526B failed: SerpApi returned HTTP 404.', 'try again')).toBe(
      'A Home Depot page could not be read. The lookup of PCL526B failed: SerpApi answered with an error (HTTP 404).',
    );
    expect(sentenceFor(`The price check of PCL526B failed: ${network}`, 'try again')).toBe(
      'The price check of PCL526B failed: SerpApi could not be reached.',
    );
  });

  it('maps a network text wherever it sits in a message (no period, dots inside, middle, start)', () => {
    expect(sentenceFor(`The lookup of PCL526B failed: ${NETWORK_ERROR_PREFIX}: Failed to fetch`, 'try again')).toBe(
      'The lookup of PCL526B failed: SerpApi could not be reached.',
    );
    expect(sentenceFor(`The lookup of PCL526B failed: ${NETWORK_ERROR_PREFIX}: getaddrinfo ENOTFOUND serpapi.com`, 'try again')).toBe(
      'The lookup of PCL526B failed: SerpApi could not be reached.',
    );
    expect(sentenceFor(`A Home Depot page could not be read. ${NETWORK_ERROR_PREFIX}: Failed to fetch. The price check of X failed: SerpApi returned HTTP 404.`, 'try again')).toBe(
      'A Home Depot page could not be read. SerpApi could not be reached. The price check of X failed: SerpApi answered with an error (HTTP 404).',
    );
  });

  it('keeps what follows a network text at the start of a message', () => {
    expect(sentenceFor(`${NETWORK_ERROR_PREFIX}: Failed to fetch. A Home Depot page could not be read.`, 'try again')).toBe(
      'SerpApi could not be reached. A Home Depot page could not be read.',
    );
    expect(sentenceFor(`${NETWORK_ERROR_PREFIX}: Failed to fetch`, 'try again')).toBe('SerpApi could not be reached. Check the connection, then try again.');
    expect(sentenceFor(`${NETWORK_ERROR_PREFIX}: serpapi.com unreachable.`, 'try again')).toBe('SerpApi could not be reached. Check the connection, then try again.');
  });
});
