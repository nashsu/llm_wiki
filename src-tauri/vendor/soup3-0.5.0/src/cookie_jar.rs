use crate::{Cookie, CookieJar};
use glib::object::IsA;
use glib::translate::*;

mod sealed {
    pub trait Sealed {}
    impl<T: glib::IsA<crate::CookieJar>> Sealed for T {}
}

pub trait CookieJarExtManual: IsA<CookieJar> + sealed::Sealed + 'static {
    #[doc(alias = "soup_cookie_jar_add_cookie")]
    fn add_cookie(&self, cookie: &mut Cookie) {
        unsafe {
            ffi::soup_cookie_jar_add_cookie(
                self.as_ref().to_glib_none().0,
                mut_override(cookie.to_glib_full()),
            );
        }
    }

    #[doc(alias = "soup_cookie_jar_add_cookie_full")]
    fn add_cookie_full(
        &self,
        cookie: &mut Cookie,
        uri: Option<&glib::Uri>,
        first_party: Option<&glib::Uri>,
    ) {
        unsafe {
            ffi::soup_cookie_jar_add_cookie_full(
                self.as_ref().to_glib_none().0,
                mut_override(cookie.to_glib_full()),
                uri.to_glib_none().0,
                first_party.to_glib_none().0,
            );
        }
    }

    #[doc(alias = "soup_cookie_jar_add_cookie_with_first_party")]
    fn add_cookie_with_first_party(&self, first_party: &glib::Uri, cookie: &mut Cookie) {
        unsafe {
            ffi::soup_cookie_jar_add_cookie_with_first_party(
                self.as_ref().to_glib_none().0,
                first_party.to_glib_none().0,
                mut_override(cookie.to_glib_full()),
            );
        }
    }

    #[doc(alias = "soup_cookie_jar_delete_cookie")]
    fn delete_cookie(&self, cookie: &mut Cookie) {
        unsafe {
            ffi::soup_cookie_jar_delete_cookie(
                self.as_ref().to_glib_none().0,
                cookie.to_glib_none_mut().0,
            );
        }
    }
}

impl<O: IsA<CookieJar>> CookieJarExtManual for O {}
