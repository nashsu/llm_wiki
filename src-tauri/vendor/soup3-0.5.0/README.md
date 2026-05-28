# Soup3-rs

[Project site](https://gitlab.gnome.org/World/Rust/soup3-rs) | [Online documentation](https://world.pages.gitlab.gnome.org/Rust/soup3-rs/git/docs/soup/)

__Rust__ bindings and wrappers for __libsoup__ v3.

## Using

We recommend using [crates from crates.io](https://crates.io/crates/soup3).

If you want to track the bleeding edge, use the git dependency instead:

```toml
[dependencies]
soup3 = { git = "https://gitlab.gnome.org/World/Rust/soup3-rs" }
```

Avoid mixing versioned and git crates like this:

```toml
# This will not compile
[dependencies]
gtk3 = "0.15"
soup3 = { git = "https://gitlab.gnome.org/World/Rust/soup3-rs" }
```

## Minimum supported Rust version

Currently, the minimum supported Rust version is `1.56.0`.

## Documentation

https://world.pages.gitlab.gnome.org/Rust/soup3-rs/git/docs/soup

## Contribute

Contributor you're welcome!

## License

__soup3-rs__ is available under the MIT License, please refer to it.
