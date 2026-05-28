use glib::translate::*;
use glib::{GString, IntoGStr, IntoOptionalGStr};
use std::collections::HashMap;
use std::ptr;

use crate::MessageHeaders;

impl MessageHeaders {
    #[doc(alias = "soup_message_headers_get_content_disposition")]
    pub fn content_disposition(&self) -> Option<(GString, HashMap<String, String>)> {
        let mut disposition = ptr::null_mut();
        let mut params = ptr::null_mut();
        unsafe {
            if bool::from_glib(ffi::soup_message_headers_get_content_disposition(
                mut_override(self.to_glib_none().0),
                &mut disposition,
                &mut params,
            )) {
                let params = if !params.is_null() {
                    HashMap::from_glib_full(params)
                } else {
                    HashMap::new()
                };
                Some((GString::from_glib_full(disposition), params))
            } else {
                None
            }
        }
    }

    #[doc(alias = "soup_message_headers_set_content_disposition")]
    pub fn set_content_disposition(
        &self,
        disposition: Option<impl IntoGStr>,
        params: Option<HashMap<String, String>>,
    ) {
        disposition.run_with_gstr(|disposition| unsafe {
            ffi::soup_message_headers_set_content_disposition(
                self.to_glib_none().0,
                disposition.to_glib_none().0,
                params.to_glib_none().0,
            )
        })
    }

    #[doc(alias = "soup_message_headers_get_content_type")]
    pub fn content_type(&self) -> Option<(GString, HashMap<String, String>)> {
        let mut params = ptr::null_mut();
        unsafe {
            let content_type = ffi::soup_message_headers_get_content_type(
                mut_override(self.to_glib_none().0),
                &mut params,
            );
            if !content_type.is_null() {
                let params = if !params.is_null() {
                    HashMap::from_glib_full(params)
                } else {
                    HashMap::new()
                };
                Some((GString::from_glib_full(content_type), params))
            } else {
                None
            }
        }
    }

    #[doc(alias = "soup_message_headers_set_content_type")]
    pub fn set_content_type(
        &self,
        content_type: Option<impl IntoGStr>,
        params: Option<HashMap<String, String>>,
    ) {
        content_type.run_with_gstr(|content_type| unsafe {
            ffi::soup_message_headers_set_content_disposition(
                self.to_glib_none().0,
                content_type.to_glib_none().0,
                params.to_glib_none().0,
            )
        })
    }
}
