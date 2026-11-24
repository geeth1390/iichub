-- The product is called IICHUB.
UPDATE notification_template
   SET subject = replace(subject, 'ProtoHub', 'IICHUB'),
       body    = replace(body, 'ProtoHub', 'IICHUB');
