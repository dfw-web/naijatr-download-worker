// Player templates adapted from Streambert src/utils/api.js (commit 1a4bf7e).
// Copyright (C) truelockmc. GPL-3.0; see LICENSE and NOTICE.
// Changes: server-only configuration, TMDB providers only, no UI settings,
// no automatic provider fallback, and no automatically approved media hosts.
// Defining a provider here does not enable it or grant rights to its media.

const providers = {
  vidsrc: {
    movie: "https://vsembed.su/embed/movie/{tmdbId}?autoplay=1",
    tv: "https://vsembed.su/embed/tv/{tmdbId}/{season}/{episode}?autoplay=1",
  },
  vidfast: {
    movie: "https://vidfast.vc/movie/{tmdbId}?autoPlay=true&poster=true&title=true&pip=hide",
    tv: "https://vidfast.vc/tv/{tmdbId}/{season}/{episode}?autoPlay=true&poster=true&title=true&pip=hide",
  },
  vidlove: {
    movie: "https://player.vidlove.cc/embed/movie/{tmdbId}?autoplay=true&autonext=false&tour=true&showNextEpisode=false&hideautonext=true&hidenextbutton=true",
    tv: "https://player.vidlove.cc/embed/tv/{tmdbId}/{season}/{episode}?autoplay=true&autonext=false&tour=true&showNextEpisode=false&hideautonext=true&hidenextbutton=true",
  },
  aether: {
    movie: "https://aether.ist/media/tmdb-movie-{tmdbId}",
    tv: "https://aether.ist/media/tmdb-tv-{tmdbId}/{season}/{episode}",
  },
  vidrift: {
    movie: "https://embed.vidrift.net/embed/movie/{tmdbId}?title=true&hide=next,episodes,cast",
    tv: "https://embed.vidrift.net/embed/tv/{tmdbId}/{season}/{episode}?title=true&hide=next,episodes,cast",
  },
  vidnest: {
    movie: "https://vidnest.fun/movie/{tmdbId}",
    tv: "https://vidnest.fun/tv/{tmdbId}/{season}/{episode}",
  },
  frembed: {
    movie: "https://frembed.uno/embed/movie/{tmdbId}",
    tv: "https://frembed.uno/embed/serie/{tmdbId}?sa={season}&epi={episode}",
  },
};

export const providerIds = Object.freeze(Object.keys(providers));

/** Fresh templates; caller cannot mutate the registry or supply a player URL. */
export function providerPlayer(id) {
  if (typeof id !== "string" || !Object.hasOwn(providers, id)) {
    throw new Error("unknown or unsupported provider; configure an approved TMDB provider");
  }
  return { ...providers[id] };
}
